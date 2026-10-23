import 'reflect-metadata';
import { Provider } from '@prisma/client';
import { AuthService } from './auth.service';
import { GoogleProvider } from './providers/google.provider';
import { AuthMiddleware, removeAuth } from './auth.middleware';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { AuthService as Tokens } from '@gitroom/helpers/auth/auth.service';

jest.mock('@prisma/client', () => ({
  Provider: {
    GOOGLE: 'GOOGLE',
    LOCAL: 'LOCAL',
    GITHUB: 'GITHUB',
    GENERIC: 'GENERIC',
  },
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/users/users.service',
  () => ({ UsersService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/services/email.service', () => ({
  EmailService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/newsletter/newsletter.service', () => ({
  NewsletterService: {},
}));
jest.mock('@gitroom/backend/services/auth/providers/providers.manager', () => ({
  AuthProviderManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/sentry/initialize.sentry', () => ({
  setSentryUserContext: jest.fn(),
}));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: {
    signJWT: (payload: object) =>
      require('jsonwebtoken').sign(payload, process.env.JWT_SECRET),
    verifyJWT: (token: string) =>
      require('jsonwebtoken').verify(token, process.env.JWT_SECRET),
  },
}));
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => {
  const values = new Map<string, string>();
  return {
    ioRedis: {
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => values.get(key)),
      getdel: jest.fn(async (key: string) => {
        const value = values.get(key);
        values.delete(key);
        return value;
      }),
    },
  };
});
jest.mock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() } } }));

describe('Google-only admission and legacy endpoint rejection', () => {
  const originalEnv = { ...process.env };
  let users: any;
  let organizations: any;
  let provider: any;
  let service: AuthService;
  const owner = {
    id: 'owner-id',
    email: 'owner@example.com',
    providerName: 'GOOGLE',
    providerId: 'owner-sub',
    activated: true,
  };
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_ONLY_AUTH: 'true',
      GOOGLE_AUTH_CLIENT_ID: 'website-login',
      GOOGLE_AUTH_CLIENT_SECRET: 'test-login-secret',
      GOOGLE_AUTH_OWNER_EMAIL: 'owner@example.com',
      GOOGLE_AUTH_ALLOWED_EMAILS: '',
      FRONTEND_URL: 'https://studio.example.com',
      GOOGLE_AUTH_CALLBACK_URL:
        'https://studio.example.com/api/auth/google/callback',
      REDIS_URL: 'redis://unused-in-mocked-tests',
      JWT_SECRET: 'test-signing-secret',
    };
    delete process.env.NOT_SECURED;
    users = {
      getUserByProvider: jest.fn(async (sub: string) =>
        sub === 'owner-sub' ? { ...owner } : null
      ),
      getUserByEmail: jest.fn(async (email: string) =>
        email === owner.email ? { ...owner } : null
      ),
      getGoogleUserByEmail: jest.fn(async (email: string) =>
        email === owner.email ? { ...owner } : null
      ),
    };
    organizations = {
      createOrgAndUser: jest.fn(async (body: any) => ({
        users: [{ user: { id: 'creator', ...body, activated: true } }],
      })),
      addUserToOrg: jest.fn(),
      getOrgsByUserId: jest.fn(async () => [
        {
          id: 'official',
          users: [{ role: 'SUPERADMIN', disabled: false }],
        },
      ]),
    };
    provider = {
      generateSecureLoginLink: jest.fn(
        () => 'https://accounts.google.com/authorize'
      ),
      getVerifiedLoginIdentity: jest.fn(async () => ({
        id: 'owner-sub',
        email: owner.email,
      })),
    };
    service = new AuthService(
      users,
      organizations,
      {} as any,
      { getProvider: () => provider } as any
    );
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function start(invite?: string) {
    const result = await service.startGoogleLogin(invite);
    const context = provider.generateSecureLoginLink.mock.calls.at(-1)[0];
    return {
      ...result,
      state: context.state,
      nonce: context.nonce,
      challenge: context.codeChallenge,
    };
  }
  const finish = (flow: any, secret = flow.browserSecret) =>
    service.finishGoogleLogin(
      'authorization-code',
      flow.state,
      secret,
      '127.0.0.1',
      'test'
    );
  const invite = (email: string, extra: object = {}) =>
    Tokens.signJWT({
      email,
      orgId: 'official',
      id: 'invitation-id',
      role: 'USER',
      timeLimit: new Date(Date.now() + 60000).toISOString(),
      ...extra,
    });

  it.each(['LOCAL', 'GITHUB', 'GOOGLE', 'GENERIC'])(
    'blocks raw %s login/registration and OAuth-token completion',
    async (name) => {
      await expect(
        service.routeAuth(name as Provider, {} as any, '', '')
      ).rejects.toThrow('Use Google');
      await expect(
        service.checkExists(
          name,
          'raw-code',
          'https://attacker.example',
          'state',
          'state'
        )
      ).rejects.toThrow('Use Google');
      expect(() => service.oauthLink(name)).toThrow('Use Google');
      expect(await service.canRegister(name)).toBe(false);
      expect(users.getUserByProvider).not.toHaveBeenCalled();
    }
  );
  it('blocks password reset and old activation tokens', async () => {
    await expect(service.forgot(owner.email)).rejects.toThrow('Use Google');
    expect(() => service.forgotReturn({} as any)).toThrow('Use Google');
    await expect(service.activate('legacy-token', '')).rejects.toThrow(
      'Use Google'
    );
    await expect(service.resendActivationEmail(owner.email)).rejects.toThrow(
      'Use Google'
    );
  });
  it.each([
    'GOOGLE_AUTH_OWNER_EMAIL',
    'GOOGLE_AUTH_CLIENT_ID',
    'GOOGLE_AUTH_CLIENT_SECRET',
    'GOOGLE_AUTH_CALLBACK_URL',
    'REDIS_URL',
  ])('fails closed without %s', async (name) => {
    delete process.env[name];
    await expect(service.startGoogleLogin()).rejects.toThrow();
  });
  it('rejects a different callback host, domain wildcard and reused uploader credentials', async () => {
    process.env.GOOGLE_AUTH_CALLBACK_URL =
      'https://other.example/api/auth/google/callback';
    await expect(service.startGoogleLogin()).rejects.toThrow();
    process.env.GOOGLE_AUTH_CALLBACK_URL =
      'https://studio.example.com/api/auth/google/callback';
    process.env.GOOGLE_AUTH_ALLOWED_EMAILS = '*@example.com';
    await expect(service.startGoogleLogin()).rejects.toThrow();
    process.env.GOOGLE_AUTH_ALLOWED_EMAILS = '';
    process.env.YOUTUBE_CLIENT_ID = process.env.GOOGLE_AUTH_CLIENT_ID;
    await expect(service.startGoogleLogin()).rejects.toThrow();
  });
  it('binds verified owner login to this browser, nonce and PKCE, then rejects replay', async () => {
    const flow = await start();
    const result = await finish(flow);
    expect(provider.getVerifiedLoginIdentity).toHaveBeenCalledWith(
      'authorization-code',
      expect.objectContaining({
        nonce: flow.nonce,
        codeVerifier: expect.any(String),
      })
    );
    const { createHash } = require('crypto');
    const context = provider.getVerifiedLoginIdentity.mock.calls[0][1];
    expect(
      createHash('sha256').update(context.codeVerifier).digest('base64url')
    ).toBe(flow.challenge);
    expect(Tokens.verifyJWT(result.jwt)).toMatchObject({
      id: owner.id,
      authMethod: 'google-only',
      googleSub: 'owner-sub',
    });
    await expect(finish(flow)).rejects.toThrow('expired');
  });
  it('rejects a stolen state without its browser cookie before exchanging the code', async () => {
    await expect(finish(await start(), 'different-browser')).rejects.toThrow(
      'browser'
    );
    expect(provider.getVerifiedLoginIdentity).not.toHaveBeenCalled();
  });
  it('rejects unknown, expired or missing state', async () => {
    await expect(
      service.finishGoogleLogin('code', 'a'.repeat(43), 'cookie', '', '')
    ).rejects.toThrow('expired');
    await expect(
      service.finishGoogleLogin('code', '', 'cookie', '', '')
    ).rejects.toThrow('expired');
  });
  it('does not admit an arbitrary verified Google email or a mismatched invitation', async () => {
    provider.getVerifiedLoginIdentity.mockResolvedValue({
      id: 'stranger-sub',
      email: 'stranger@example.com',
    });
    await expect(finish(await start())).rejects.toThrow('access list');
    await expect(
      finish(await start(invite('someone-else@example.com')))
    ).rejects.toThrow('access list');
    expect(organizations.createOrgAndUser).not.toHaveBeenCalled();
    expect(users.getUserByProvider).not.toHaveBeenCalled();
  });
  it('rejects expired, malformed or non-owner workspace invitations', async () => {
    provider.getVerifiedLoginIdentity.mockResolvedValue({
      id: 'expired-sub',
      email: 'expired@example.com',
    });
    await expect(
      finish(
        await start(invite('expired@example.com', { timeLimit: '2000-01-01' }))
      )
    ).rejects.toThrow('access list');
    await expect(
      finish(
        await start(invite('expired@example.com', { timeLimit: 'invalid' }))
      )
    ).rejects.toThrow('access list');
    await expect(
      finish(
        await start(
          invite('expired@example.com', { orgId: 'someone-elses-org' })
        )
      )
    ).rejects.toThrow('access list');
  });
  it('admits only the exact listed identity to a private workspace without joining the official organization', async () => {
    process.env.GOOGLE_AUTH_ALLOWED_EMAILS = 'invited@example.com';
    provider.getVerifiedLoginIdentity.mockResolvedValue({
      id: 'invited-sub',
      email: 'invited@example.com',
    });
    const result = await finish(await start(invite('invited@example.com')));
    expect(Tokens.verifyJWT(result.jwt)).toMatchObject({
      email: 'invited@example.com',
      googleSub: 'invited-sub',
    });
    expect(organizations.createOrgAndUser).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'GOOGLE',
        email: 'invited@example.com',
      }),
      expect.any(String),
      expect.any(String)
    );
    expect(organizations.addUserToOrg).not.toHaveBeenCalled();
    // The explicit list, rather than the ignored invitation, grants admission.
    await expect(finish(await start())).resolves.toHaveProperty('jwt');
  });
  it('refuses matching owner invitations and historical Redis admissions before any user or organization creation', async () => {
    const email = 'previously-invited@example.com',
      id = 'previously-invited-sub';
    provider.getVerifiedLoginIdentity.mockResolvedValue({ id, email });
    await ioRedis.set(
      `google-admission:${id}`,
      JSON.stringify({ email, owner: 'owner@example.com' })
    );
    await expect(finish(await start(invite(email)))).rejects.toThrow(
      'access list'
    );
    expect(users.getUserByProvider).not.toHaveBeenCalled();
    expect(users.getUserByEmail).not.toHaveBeenCalled();
    expect(organizations.createOrgAndUser).not.toHaveBeenCalled();
    expect(organizations.addUserToOrg).not.toHaveBeenCalled();
  });
  it('never links a Google identity to an existing password account by email', async () => {
    process.env.GOOGLE_AUTH_ALLOWED_EMAILS = 'existing@example.com';
    provider.getVerifiedLoginIdentity.mockResolvedValue({
      id: 'other-sub',
      email: 'existing@example.com',
    });
    users.getUserByEmail.mockResolvedValue({
      id: 'local-id',
      providerName: 'LOCAL',
    });
    await expect(finish(await start())).rejects.toThrow('another sign-in');
    expect(organizations.createOrgAndUser).not.toHaveBeenCalled();
  });
  it('keeps legacy login available when the new mode is disabled', () => {
    delete process.env.GOOGLE_ONLY_AUTH;
    expect(() => service.assertLegacyLoginAllowed()).not.toThrow();
  });

  it('clears a host-only session cookie', () => {
    const response: any = { cookie: jest.fn(), header: jest.fn() };
    removeAuth(response);
    const options = response.cookie.mock.calls[0][2];
    expect(options).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(options).not.toHaveProperty('domain');
  });
  it('rejects legacy sessions from cookies or SSR headers in the actual session middleware', async () => {
    const middleware = new AuthMiddleware(organizations, {
      getUserById: async () => owner,
    } as any);
    const next = jest.fn();
    await expect(
      middleware.use(
        { headers: {}, cookies: { auth: Tokens.signJWT(owner) } } as any,
        {} as any,
        next
      )
    ).rejects.toThrow();
    await expect(
      middleware.use(
        { headers: { auth: Tokens.signJWT(owner) }, cookies: {} } as any,
        {} as any,
        next
      )
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
  it('accepts a verified Google-only session forwarded by server-rendered pages', async () => {
    const middleware = new AuthMiddleware(
      {
        getOrgsByUserId: async () => [
          {
            id: 'official',
            apiKey: 'opaque-internal-key',
            users: [{ disabled: false }],
          },
        ],
      } as any,
      { getUserById: async () => ({ ...owner }) } as any
    );
    const next = jest.fn();
    const token = Tokens.signJWT({
      id: owner.id,
      email: owner.email,
      authMethod: 'google-only',
      googleSub: owner.providerId,
    });
    await middleware.use(
      { headers: { auth: token }, cookies: {} } as any,
      {} as any,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
  it.each(['cookie', 'header'])(
    'revokes an existing %s session immediately when its email is removed',
    async (transport) => {
      const creator = {
        ...owner,
        id: 'creator-id',
        email: 'creator@example.com',
        providerId: 'creator-sub',
      };
      process.env.GOOGLE_AUTH_ALLOWED_EMAILS = creator.email;
      const orgs = {
        getOrgsByUserId: jest.fn(async () => [
          {
            id: 'private',
            apiKey: 'internal-key',
            users: [{ disabled: false }],
          },
        ]),
        updateApiKey: jest.fn(),
      };
      const middleware = new AuthMiddleware(
        orgs as any,
        { getUserById: async () => ({ ...creator }) } as any
      );
      const token = Tokens.signJWT({
        id: creator.id,
        email: creator.email,
        googleSub: creator.providerId,
        authMethod: 'google-only',
      });
      const request = () => ({
        headers: transport === 'header' ? { auth: token } : {},
        cookies: transport === 'cookie' ? { auth: token } : {},
      });
      const next = jest.fn();
      await middleware.use(request() as any, {} as any, next);
      expect(next).toHaveBeenCalledTimes(1);
      process.env.GOOGLE_AUTH_ALLOWED_EMAILS = '';
      orgs.getOrgsByUserId.mockClear();
      next.mockClear();
      await expect(
        middleware.use(request() as any, {} as any, next)
      ).rejects.toMatchObject({ status: 403 });
      expect(next).not.toHaveBeenCalled();
      expect(orgs.getOrgsByUserId).not.toHaveBeenCalled();
      expect(orgs.updateApiKey).not.toHaveBeenCalled();
    }
  );
});

describe('Google provider verified identity', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  it('verifies the dedicated login audience and keeps Google identity tokens on the server', async () => {
    process.env.GOOGLE_AUTH_CLIENT_ID = 'website-login';
    process.env.GOOGLE_AUTH_CLIENT_SECRET = 'test-secret';
    const { google } = require('googleapis');
    const getToken = jest.fn(async () => ({
      tokens: {
        id_token: 'signed-id-token',
        access_token: 'private-access-token',
      },
    }));
    const verifyIdToken = jest.fn(async () => ({
      getPayload: () => ({
        sub: 'google-sub',
        email: 'Creator@Example.com',
        email_verified: true,
        nonce: 'nonce',
      }),
    }));
    google.auth.OAuth2.mockImplementation(() => ({ getToken, verifyIdToken }));
    const redirectUri = 'https://studio.example.com/api/auth/google/callback';
    await expect(
      new GoogleProvider().getVerifiedLoginIdentity('code', {
        redirectUri,
        nonce: 'nonce',
        codeVerifier: 'verifier',
      })
    ).resolves.toEqual({ id: 'google-sub', email: 'creator@example.com' });
    expect(getToken).toHaveBeenCalledWith({
      code: 'code',
      codeVerifier: 'verifier',
      redirect_uri: redirectUri,
    });
    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'signed-id-token',
      audience: 'website-login',
    });
  });
  it.each([
    {
      sub: 'sub',
      email: 'creator@example.com',
      email_verified: false,
      nonce: 'nonce',
    },
    {
      sub: 'sub',
      email: 'creator@example.com',
      email_verified: true,
      nonce: 'wrong',
    },
    { email: 'creator@example.com', email_verified: true, nonce: 'nonce' },
  ])(
    'rejects unverified or nonce-mismatched identities: %p',
    async (payload) => {
      process.env.GOOGLE_AUTH_CLIENT_ID = 'website-login';
      process.env.GOOGLE_AUTH_CLIENT_SECRET = 'test-secret';
      const { google } = require('googleapis');
      google.auth.OAuth2.mockImplementation(() => ({
        getToken: jest.fn(async () => ({
          tokens: { id_token: 'signed-id-token' },
        })),
        verifyIdToken: jest.fn(async () => ({ getPayload: () => payload })),
      }));
      await expect(
        new GoogleProvider().getVerifiedLoginIdentity('code', {
          redirectUri: 'https://studio.example.com/api/auth/google/callback',
          nonce: 'nonce',
          codeVerifier: 'verifier',
        })
      ).rejects.toThrow('verified');
    }
  );
});
