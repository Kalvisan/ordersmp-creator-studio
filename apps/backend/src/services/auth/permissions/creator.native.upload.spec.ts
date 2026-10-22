import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MediaController } from '../../../api/routes/media.controller';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';

jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({
  OpenaiService: class {},
}));
jest.mock('@gitroom/nestjs-libraries/openai/generation.error', () => ({
  generationError: jest.fn(),
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/videos/video.manager', () => ({
  VideoManager: class {},
}));
jest.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}), createProcessor: () => null },
}));
jest.mock('@gitroom/nestjs-libraries/upload/r2.uploader', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('@gitroom/nestjs-libraries/upload/multer.stream.engine', () => ({
  streamUploadOptions: () => ({}),
}));
jest.mock('@gitroom/nestjs-libraries/upload/custom.upload.validation', () => ({
  getMaxSize: () => 1,
  uploadStreamToStorage: jest.fn(),
}));
jest.mock(
  '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher',
  () => ({ ssrfSafeDispatcher: {} })
);
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock(
  '@gitroom/nestjs-libraries/temporal/temporal.search.attribute',
  () => ({ organizationId: {} })
);
jest.mock('@gitroom/nestjs-libraries/dtos/videos/video.dto', () => ({
  VideoDto: class {},
}));
jest.mock('@gitroom/nestjs-libraries/dtos/videos/video.function.dto', () => ({
  VideoFunctionDto: class {},
}));

describe('Exact owner-only native upload registration lookup', () => {
  const previous = { ...process.env };
  const relative = `2026/10/24/${'a'.repeat(32)}.png`;
  let findFirst: jest.Mock, service: MediaService, controller: MediaController;
  const org = () =>
    ({
      id: 'current-org',
      users: [{ role: 'SUPERADMIN', disabled: false }],
    } as any);
  const owner = () => ({ id: 'owner-id', email: 'owner@example.com' } as any);
  beforeEach(() => {
    process.env = {
      ...previous,
      GOOGLE_ONLY_AUTH: 'true',
      GOOGLE_AUTH_OWNER_EMAIL: 'owner@example.com',
      FRONTEND_URL: 'https://studio.example.com',
    };
    findFirst = jest.fn(async () => ({ id: 'registered-id' }));
    const repository = new MediaRepository({
      model: { media: { findFirst } },
    } as any);
    service = new MediaService(
      repository,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    controller = new MediaController(service, {} as any);
  });
  afterEach(() => {
    process.env = { ...previous };
  });

  it('runs one indexed, exact, current-org query and returns only registration status', async () => {
    await expect(
      controller.lookupNativeUpload(org(), owner(), { relative })
    ).resolves.toEqual({ registered: true });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'current-org',
        name: `${'a'.repeat(32)}.png`,
        path: `https://studio.example.com/uploads/${relative}`,
        deletedAt: null,
        status: { not: 'processing' },
      },
      select: { id: true },
    });
    findFirst.mockResolvedValue(null);
    await expect(
      controller.lookupNativeUpload(org(), owner(), { relative })
    ).resolves.toEqual({ registered: false });
  });

  it.each(['USER', undefined])(
    'rejects owner email without an active owner role: %s',
    async (role) => {
      const organization = org();
      organization.users[0].role = role;
      await expect(
        controller.lookupNativeUpload(organization, owner(), { relative })
      ).rejects.toThrow(ForbiddenException);
      expect(findFirst).not.toHaveBeenCalled();
    }
  );
  it('rejects a different creator, disabled owner and legacy mode without database reads', async () => {
    await expect(
      controller.lookupNativeUpload(
        org(),
        { ...owner(), email: 'creator@example.com' },
        { relative }
      )
    ).rejects.toThrow(ForbiddenException);
    const disabled = org();
    disabled.users[0].disabled = true;
    await expect(
      controller.lookupNativeUpload(disabled, owner(), { relative })
    ).rejects.toThrow(ForbiddenException);
    process.env.GOOGLE_ONLY_AUTH = 'false';
    await expect(
      controller.lookupNativeUpload(org(), owner(), { relative })
    ).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it.each([
    '../service.env',
    '2026/10/24/file.png',
    'https://other.example/file.png',
    relative + '?original=true',
    relative + '\n',
  ])('rejects an invalid native path without a query: %s', async (path) => {
    await expect(
      service.isRegisteredNativeUpload('current-org', path)
    ).rejects.toThrow(BadRequestException);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it('accepts the full native random-name range rather than assuming exactly32 characters', async () => {
    await expect(
      service.isRegisteredNativeUpload(
        'current-org',
        relative.replace('a'.repeat(32), '10'.repeat(32))
      )
    ).resolves.toBe(true);
  });
});
