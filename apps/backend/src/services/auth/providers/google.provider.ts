import { google } from 'googleapis';
import { HttpException } from '@nestjs/common';
import { CodeChallengeMethod } from 'google-auth-library';
import {
  AuthProvider,
  AuthProviderAbstract,
} from '@gitroom/backend/services/auth/providers.interface';

const defaultRedirect = () =>
  `${process.env.FRONTEND_URL}/integrations/social/youtube`;

const makeClient = (redirectUri: string) =>
  new google.auth.OAuth2({
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    redirectUri,
  });

@AuthProvider({ provider: 'GOOGLE' })
export class GoogleProvider extends AuthProviderAbstract {
  // Website login has its own OAuth client, separate from YouTube publishing.
  private loginClient(redirectUri: string) {
    if (
      !process.env.GOOGLE_AUTH_CLIENT_ID ||
      !process.env.GOOGLE_AUTH_CLIENT_SECRET ||
      process.env.GOOGLE_AUTH_CLIENT_ID === process.env.YOUTUBE_CLIENT_ID
    ) {
      throw new Error('Dedicated Google login credentials are required');
    }
    return new google.auth.OAuth2({
      clientId: process.env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
      redirectUri,
    });
  }

  generateSecureLoginLink(query: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }) {
    return this.loginClient(query.redirectUri).generateAuthUrl({
      access_type: 'online',
      prompt: 'select_account',
      scope: ['openid', 'email'],
      state: query.state,
      nonce: query.nonce,
      code_challenge: query.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }

  async getVerifiedLoginIdentity(
    code: string,
    context: { redirectUri: string; nonce: string; codeVerifier: string }
  ) {
    const client = this.loginClient(context.redirectUri);
    const { tokens } = await client.getToken({
      code,
      codeVerifier: context.codeVerifier,
      redirect_uri: context.redirectUri,
    });
    if (!tokens.id_token) {
      throw new Error('Google did not return a verified identity');
    }
    // Google verifies the signature, issuer, expiry and our login audience.
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_AUTH_CLIENT_ID,
    });
    const identity = ticket.getPayload();
    if (
      !identity?.sub ||
      !identity.email ||
      identity.email_verified !== true ||
      (identity as typeof identity & { nonce?: string }).nonce !== context.nonce
    ) {
      throw new Error('Google identity could not be verified');
    }
    return { id: identity.sub, email: identity.email.toLowerCase() };
  }

  generateLink(query?: { redirect_uri?: string; state?: string }) {
    const redirectUri = query?.redirect_uri || defaultRedirect();
    return makeClient(redirectUri).generateAuthUrl({
      access_type: 'online',
      prompt: 'consent',
      state: query?.state || 'login',
      redirect_uri: redirectUri,
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
    });
  }

  async getToken(code: string, redirectUri?: string) {
    const client = makeClient(redirectUri || defaultRedirect());
    try {
      const { tokens } = await client.getToken(code);
      return tokens.access_token!;
    } catch (err: any) {
      // The code is single use and short lived (callback reloaded or too slow)
      if (err?.response?.data?.error === 'invalid_grant') {
        throw new HttpException(
          'Google sign-in expired, please sign in again',
          400
        );
      }
      throw err;
    }
  }

  async getUser(providerToken: string) {
    const client = makeClient(defaultRedirect());
    client.setCredentials({ access_token: providerToken });
    const { data } = await google
      .oauth2({ version: 'v2', auth: client })
      .userinfo.get();

    return {
      id: data.id!,
      email: data.email!,
    };
  }
}
