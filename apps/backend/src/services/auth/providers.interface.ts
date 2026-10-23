import { Injectable } from '@nestjs/common';

export abstract class AuthProviderAbstract {
  generateSecureLoginLink(query: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string {
    throw new Error('Secure login is unavailable for this provider');
  }

  async getVerifiedLoginIdentity(
    code: string,
    context: { redirectUri: string; nonce: string; codeVerifier: string }
  ): Promise<{ email: string; id: string }> {
    throw new Error('Secure login is unavailable for this provider');
  }

  abstract generateLink(query?: any): Promise<string> | string;
  abstract getToken(code: string, redirectUri?: string): Promise<string>;
  abstract getUser(
    providerToken: string
  ): Promise<{ email: string; id: string }> | false;
  async postRegistration(providerToken: string, orgId: string): Promise<void> {}
}

export interface AuthProviderParams {
  provider: string;
}

export function AuthProvider(params: AuthProviderParams) {
  return function (target: any) {
    Injectable()(target);

    const existingMetadata =
      Reflect.getMetadata('auth-provider', AuthProviderAbstract) || [];

    existingMetadata.push({ target, provider: params.provider });

    Reflect.defineMetadata(
      'auth-provider',
      existingMetadata,
      AuthProviderAbstract
    );
  };
}
