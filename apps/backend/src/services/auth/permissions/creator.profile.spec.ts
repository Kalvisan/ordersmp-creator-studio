import 'reflect-metadata';
import { UsersController } from '../../../api/routes/users.controller';
jest.mock('@prisma/client', () => ({}));

jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/services/payment/payment.service', () => ({
  PaymentService: class {},
}));
jest.mock('@gitroom/backend/services/auth/auth.service', () => ({
  AuthService: class {},
}));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({
  AuthService: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/users/users.service',
  () => ({ UsersService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));

describe('Creator identity response', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_ONLY_AUTH: 'true',
      GOOGLE_AUTH_OWNER_EMAIL: 'owner@example.com',
    };
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each(['creator@example.com', 'owner@example.com'])(
    'returns only safe identity fields for %s, including legacy SUPERADMIN private organisations',
    async (email) => {
      const controller = new UsersController(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );
      const result = await controller.getSelf(
        {
          id: 'user',
          email,
          name: 'Creator',
          timezone: 0,
          password: 'private-password',
          providerId: 'google-sub',
          ip: 'private-ip',
          inviteId: 'private-invite',
          account: 'private-account',
          agent: 'private-user-agent',
          isSuperAdmin: true,
        } as any,
        {
          id: 'personal',
          apiKey: 'private-org-key',
          users: [{ role: 'SUPERADMIN' }],
        } as any,
        {} as any
      );
      expect(result).toMatchObject({
        id: 'user',
        email,
        orgId: 'personal',
        admin: false,
      });
      for (const field of [
        'password',
        'providerId',
        'ip',
        'inviteId',
        'account',
        'agent',
        'apiKey',
        'publicApi',
        'isSuperAdmin',
      ]) {
        expect(result).not.toHaveProperty(field);
      }
    }
  );
  it('returns only the current private workspace to a creator without exposing membership objects', async () => {
    const controller = new UsersController(
      {} as any,
      {} as any,
      {} as any,
      {
        getOrgsByUserId: async () => [
          {
            id: 'personal',
            name: 'Creator workspace',
            users: [{ role: 'SUPERADMIN' }],
          },
          {
            id: 'old-shared',
            name: 'Other creators',
            users: [{ role: 'ADMIN' }],
          },
        ],
      } as any,
      {} as any,
      {} as any
    );
    await expect(
      controller.getOrgs(
        { id: 'user', email: 'creator@example.com' } as any,
        { id: 'personal' } as any
      )
    ).resolves.toEqual([
      { id: 'personal', name: 'Creator workspace', users: [{ role: 'USER' }] },
    ]);
  });
});
