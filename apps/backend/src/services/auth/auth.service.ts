import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { isEmail } from 'class-validator';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { Provider, User } from '@prisma/client';
import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@gitroom/nestjs-libraries/dtos/auth/login.user.dto';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { AuthProviderManager } from '@gitroom/backend/services/auth/providers/providers.manager';
import dayjs from 'dayjs';
import { ForgotReturnPasswordDto } from '@gitroom/nestjs-libraries/dtos/auth/forgot-return.password.dto';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { NewsletterService } from '@gitroom/nestjs-libraries/newsletter/newsletter.service';

// Read current configuration on every admission check, including existing sessions.
export function googleEmailAllowed(email: string) {
  const owner = process.env.GOOGLE_AUTH_OWNER_EMAIL?.trim().toLowerCase();
  const allowed = (process.env.GOOGLE_AUTH_ALLOWED_EMAILS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return (
    !!owner &&
    isEmail(owner) &&
    !owner.includes('*') &&
    allowed.every((value) => isEmail(value) && !value.includes('*')) &&
    typeof email === 'string' &&
    [owner, ...allowed].includes(email.trim().toLowerCase())
  );
}

@Injectable()
export class AuthService {
  constructor(
    private _userService: UsersService,
    private _organizationService: OrganizationService,
    private _emailService: EmailService,
    private _providerManager: AuthProviderManager
  ) {}

  googleOnly() {
    return process.env.GOOGLE_ONLY_AUTH === 'true';
  }

  assertLegacyLoginAllowed() {
    if (this.googleOnly()) {
      throw new ForbiddenException('Use Google to sign in');
    }
  }

  private googleLoginConfig() {
    if (!this.googleOnly()) {
      throw new ForbiddenException('Google-only login is disabled');
    }
    const owner = process.env.GOOGLE_AUTH_OWNER_EMAIL?.trim().toLowerCase();
    const allowed = (process.env.GOOGLE_AUTH_ALLOWED_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    const frontend = new URL(process.env.FRONTEND_URL || '');
    const callback = new URL(process.env.GOOGLE_AUTH_CALLBACK_URL || '');
    if (
      !owner ||
      !isEmail(owner) ||
      owner.includes('*') ||
      allowed.some((email) => !isEmail(email) || email.includes('*')) ||
      frontend.protocol !== 'https:' ||
      callback.protocol !== 'https:' ||
      frontend.origin !== callback.origin ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      !callback.pathname.endsWith('/auth/google/callback') ||
      !process.env.REDIS_URL ||
      process.env.NOT_SECURED ||
      !process.env.GOOGLE_AUTH_CLIENT_ID ||
      !process.env.GOOGLE_AUTH_CLIENT_SECRET ||
      process.env.GOOGLE_AUTH_CLIENT_ID === process.env.YOUTUBE_CLIENT_ID
    ) {
      throw new ForbiddenException('Google login configuration is incomplete');
    }
    return {
      owner,
      allowed,
      callback: callback.toString(),
      frontend: frontend.toString(),
    };
  }

  async startGoogleLogin(_invitation?: string) {
    const config = this.googleLoginConfig();
    const state = randomBytes(32).toString('base64url');
    const browserSecret = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const url = this._providerManager
      .getProvider(Provider.GOOGLE)
      .generateSecureLoginLink({
        redirectUri: config.callback,
        state,
        nonce,
        codeChallenge: createHash('sha256')
          .update(codeVerifier)
          .digest('base64url'),
      });
    await ioRedis.set(
      `google-login:${state}`,
      JSON.stringify({
        browserHash: createHash('sha256').update(browserSecret).digest('hex'),
        nonce,
        codeVerifier,
      }),
      'EX',
      600
    );
    return { url, browserSecret };
  }

  async finishGoogleLogin(
    code: string,
    state: string,
    browserSecret: string,
    ip: string,
    userAgent: string
  ) {
    const config = this.googleLoginConfig();
    if (!code || !/^[A-Za-z0-9_-]{43}$/.test(state || '') || !browserSecret) {
      throw new ForbiddenException('Google sign-in expired. Sign in again.');
    }
    // GETDEL makes the callback single use even across server replicas.
    const pending = await ioRedis.getdel(`google-login:${state}`);
    if (!pending) {
      throw new ForbiddenException('Google sign-in expired. Sign in again.');
    }
    const context = JSON.parse(pending);
    if (
      context.browserHash !==
      createHash('sha256').update(browserSecret).digest('hex')
    ) {
      throw new ForbiddenException('Google sign-in did not match this browser');
    }
    const identity = await this._providerManager
      .getProvider(Provider.GOOGLE)
      .getVerifiedLoginIdentity(code, {
        redirectUri: config.callback,
        nonce: context.nonce,
        codeVerifier: context.codeVerifier,
      });
    const email = identity.email?.trim().toLowerCase();
    if (!identity.id || !email || !isEmail(email)) {
      throw new ForbiddenException('Google identity could not be verified');
    }
    // Invitations and historical Redis admissions cannot extend this explicit list.
    if (!googleEmailAllowed(email))
      throw new ForbiddenException(
        'Ask the owner to add your email to the access list'
      );
    let user = await this._userService.getUserByProvider(
      identity.id,
      Provider.GOOGLE
    );
    if (user && user.email.toLowerCase() !== email) {
      throw new ForbiddenException(
        'Google account identity has changed. Contact the owner.'
      );
    }
    if (!user) {
      if (await this._userService.getUserByEmail(email)) {
        throw new ForbiddenException(
          'This email belongs to another sign-in account'
        );
      }
      const created = await this._organizationService.createOrgAndUser(
        {
          company:
            email === config.owner ? 'Creator Studio' : 'Creator workspace',
          email,
          password: '',
          provider: Provider.GOOGLE,
          providerId: identity.id,
          datafast_visitor_id: '',
        },
        ip,
        userAgent
      );
      user = created.users[0].user;
    }
    if (!user.activated || user.deletedAt) {
      throw new ForbiddenException('This account is disabled');
    }
    return {
      jwt: AuthChecker.signJWT({
        id: user.id,
        email,
        authMethod: 'google-only',
        googleSub: identity.id,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8,
      }),
      frontend: config.frontend,
    };
  }

  async canRegister(provider: string) {
    if (this.googleOnly()) return false;
    if (
      process.env.DISABLE_REGISTRATION !== 'true' ||
      provider === Provider.GENERIC
    ) {
      return true;
    }

    return (await this._organizationService.getCount()) === 0;
  }

  async routeAuth(
    provider: Provider,
    body: CreateOrgUserDto | LoginUserDto,
    ip: string,
    userAgent: string,
    addToOrg?: boolean | { orgId: string; role: 'USER' | 'ADMIN'; id: string }
  ) {
    this.assertLegacyLoginAllowed();
    if (provider === Provider.LOCAL) {
      if (process.env.DISALLOW_PLUS && body.email.includes('+')) {
        throw new Error('Email with plus sign is not allowed');
      }
      if (body instanceof CreateOrgUserDto) {
        body.email = body.email.toLowerCase();
      }
      const user = await this._userService.getUserByEmail(body.email);
      if (body instanceof CreateOrgUserDto) {
        if (user) {
          throw new Error('Email already exists');
        }

        if (!(await this.canRegister(provider))) {
          throw new Error('Registration is disabled');
        }

        const create = await this._organizationService.createOrgAndUser(
          body,
          ip,
          userAgent
        );

        const addedOrg =
          addToOrg && typeof addToOrg !== 'boolean'
            ? await this._organizationService.addUserToOrg(
                create.users[0].user.id,
                addToOrg.id,
                addToOrg.orgId,
                addToOrg.role
              )
            : false;

        const obj = { addedOrg, jwt: await this.jwt(create.users[0].user) };
        await this._emailService.sendEmailSync(
          body.email,
          'Activate your account',
          `Click <a href="${process.env.FRONTEND_URL}/auth/activate/${obj.jwt}">here</a> to activate your account`
        );
        return obj;
      }

      if (!user || !AuthChecker.comparePassword(body.password, user.password)) {
        throw new Error('Invalid user name or password');
      }

      if (!user.activated) {
        throw new Error('User is not activated');
      }

      return { addedOrg: false, jwt: await this.jwt(user) };
    }

    const user = await this.loginOrRegisterProvider(
      provider,
      body as CreateOrgUserDto,
      ip,
      userAgent
    );

    const addedOrg =
      addToOrg && typeof addToOrg !== 'boolean'
        ? await this._organizationService.addUserToOrg(
            user.id,
            addToOrg.id,
            addToOrg.orgId,
            addToOrg.role
          )
        : false;
    return { addedOrg, jwt: await this.jwt(user) };
  }

  public getOrgFromCookie(cookie?: string) {
    if (!cookie) {
      return false;
    }

    try {
      const getOrg: any = AuthChecker.verifyJWT(cookie);
      if (
        !getOrg.timeLimit ||
        !dayjs(getOrg.timeLimit).isValid() ||
        dayjs(getOrg.timeLimit).isBefore(dayjs())
      ) {
        return false;
      }

      return getOrg as {
        email: string;
        role: 'USER' | 'ADMIN';
        orgId: string;
        id: string;
      };
    } catch (err) {
      return false;
    }
  }

  private async loginOrRegisterProvider(
    provider: Provider,
    body: CreateOrgUserDto,
    ip: string,
    userAgent: string
  ) {
    const providerInstance = this._providerManager.getProvider(provider);
    const providerUser = await providerInstance.getUser(body.providerToken);

    if (!providerUser) {
      throw new Error('Invalid provider token');
    }

    const user = await this._userService.getUserByProvider(
      providerUser.id,
      provider
    );
    if (user) {
      return user;
    }

    if (!(await this.canRegister(provider))) {
      throw new Error('Registration is disabled');
    }

    const create = await this._organizationService.createOrgAndUser(
      {
        company: body.company,
        email: providerUser.email,
        password: '',
        provider,
        providerId: providerUser.id,
        datafast_visitor_id: body.datafast_visitor_id,
      },
      ip,
      userAgent
    );

    this._track('register', providerUser.email, body.datafast_visitor_id).catch(
      (err) => {}
    );

    await NewsletterService.register(providerUser.email);

    try {
      if (providerInstance?.postRegistration) {
        await providerInstance.postRegistration(body.providerToken, create.id);
      }
    } catch (err) {
      // Don't fail registration if postRegistration fails
    }

    return create.users[0].user;
  }

  private async _track(
    name: string,
    email: string,
    datafast_visitor_id: string
  ) {
    if (email && datafast_visitor_id && process.env.DATAFAST_API_KEY) {
      try {
        await fetch('https://datafa.st/api/v1/goals', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.DATAFAST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            datafast_visitor_id: datafast_visitor_id,
            name: name,
            metadata: {
              email,
            },
          }),
        });
      } catch (err) {}
    }
  }

  async forgot(email: string) {
    this.assertLegacyLoginAllowed();
    const user = await this._userService.getUserByEmail(email);
    if (!user || user.providerName !== Provider.LOCAL) {
      return false;
    }

    const resetValues = AuthChecker.signJWT({
      id: user.id,
      expires: dayjs().add(20, 'minutes').format('YYYY-MM-DD HH:mm:ss'),
    });

    await this._emailService.sendEmailSync(
      user.email,
      'Reset your password',
      `You have requested to reset your password. <br />Click <a href="${process.env.FRONTEND_URL}/auth/forgot/${resetValues}">here</a> to reset your password<br />The link will expire in 20 minutes`
    );
  }

  forgotReturn(body: ForgotReturnPasswordDto) {
    this.assertLegacyLoginAllowed();
    const user = AuthChecker.verifyJWT(body.token) as {
      id: string;
      expires: string;
    };
    if (dayjs(user.expires).isBefore(dayjs())) {
      return false;
    }

    return this._userService.updatePassword(user.id, body.password);
  }

  async activate(code: string, tracking: string) {
    this.assertLegacyLoginAllowed();
    const user = AuthChecker.verifyJWT(code) as {
      id: string;
      activated: boolean;
      email: string;
    };
    if (user.id && !user.activated) {
      const getUserAgain = await this._userService.getUserByEmail(user.email);
      if (getUserAgain.activated) {
        return false;
      }
      await this._userService.activateUser(user.id);
      user.activated = true;
      this._track('register', user.email, tracking).catch((err) => {});
      await NewsletterService.register(user.email);
      return this.jwt(user as any);
    }

    return false;
  }

  async resendActivationEmail(email: string) {
    this.assertLegacyLoginAllowed();
    const user = await this._userService.getUserByEmail(email);

    if (!user) {
      throw new Error('User not found');
    }

    if (user.activated) {
      throw new Error('Account is already activated');
    }

    const jwt = await this.jwt(user);

    await this._emailService.sendEmailSync(
      user.email,
      'Activate your account',
      `Click <a href="${process.env.FRONTEND_URL}/auth/activate/${jwt}">here</a> to activate your account`
    );

    return true;
  }

  oauthLink(provider: string, query?: any) {
    this.assertLegacyLoginAllowed();
    const providerInstance = this._providerManager.getProvider(provider);
    return providerInstance.generateLink(query);
  }

  async checkExists(
    provider: string,
    code: string,
    redirectUri?: string,
    state?: string,
    stateCookie?: string
  ) {
    this.assertLegacyLoginAllowed();
    // the mobile app passes redirect_uri and keeps no cookies, the web flow
    // never passes it, so the state nonce is only enforced for the web flow
    if (
      !process.env.NOT_SECURED &&
      !redirectUri &&
      (!state || state !== stateCookie)
    ) {
      throw new Error('Invalid state');
    }

    const providerInstance = this._providerManager.getProvider(provider);
    const token = await providerInstance.getToken(code, redirectUri);
    const user = await providerInstance.getUser(token);
    if (!user) {
      throw new Error('Invalid user');
    }
    const checkExists = await this._userService.getUserByProvider(
      user.id,
      provider as Provider
    );
    if (checkExists) {
      return { jwt: await this.jwt(checkExists) };
    }

    return { token };
  }

  private async jwt(user: User) {
    if (user.password) {
      delete user.password;
    }
    return AuthChecker.signJWT(user);
  }
}
