import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import {
  CreatorPublishingGuard,
  creatorMediaHash,
  creatorRequestHash,
  canonicalCreatorJson,
} from './creator.publishing.guard';
import { PoliciesGuard } from './permissions.guard';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

jest.mock(
  '@gitroom/backend/services/auth/permissions/permissions.service',
  () => ({ PermissionsService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(async () => 'OK') },
}));

const owner = 'owner@example.com';
const secret = 'test-review-secret-with-at-least-32-characters';
const now = 1800000000;
const approvalId = '11111111-2222-4333-8444-555555555555';
const body = () => ({
  type: 'now',
  date: '2027-01-15T08:00:00Z',
  shortLink: false,
  tags: [],
  posts: [
    {
      integration: { id: 'youtube-account' },
      settings: { title: 'A real build' },
      value: [
        {
          content: 'Minecraft. On record.',
          image: [
            {
              id: 'media',
              path: 'https://media.example/immutable/video.mp4',
              sha256: 'a'.repeat(64),
            },
          ],
        },
      ],
    },
  ],
});

function request(): any {
  return {
    method: 'POST',
    path: '/public/v1/posts',
    headers: {},
    body: body(),
    org: { id: 'official', users: [{ role: 'SUPERADMIN', disabled: false }] },
    user: { id: 'owner-id', email: owner },
    params: {},
  };
}

function approval(req: any, changes: Record<string, unknown> = {}) {
  return {
    v: 1,
    approvalId,
    method: req.method,
    path: req.path.replace(/\/+$/, ''),
    orgId: req.org.id,
    bodyHash: creatorRequestHash(req.body),
    mediaHash: creatorMediaHash(req.body),
    permissionId: 'permission-001',
    reviewerEmail: owner,
    issuedAt: now,
    expiresAt: now + 120,
    ...changes,
  };
}

function sign(
  req: any,
  changes: Record<string, unknown> = {},
  signingSecret = secret
) {
  const encoded = Buffer.from(JSON.stringify(approval(req, changes))).toString(
    'base64url'
  );
  req.headers['x-creator-publish-approval'] =
    encoded +
    '.' +
    createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  return req;
}

describe('Owner review attestation at dispatch', () => {
  const originalEnv = { ...process.env };
  let used: Set<string>;
  let consume: jest.Mock;
  let guard: CreatorPublishingGuard;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      GOOGLE_AUTH_OWNER_EMAIL: owner,
      CREATOR_PUBLISH_APPROVAL_SECRET: secret,
    };
    delete process.env.CREATOR_PUBLISH_APPROVAL_SECRET_FILE;
    used = new Set();
    consume = jest.fn(async (id: string) => {
      if (used.has(id)) return false;
      used.add(id);
      return true;
    });
    guard = new CreatorPublishingGuard(consume, () => now);
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts the exact reviewed media, account and caption once, with a bounded replay-store TTL', async () => {
    const req = sign(request());
    expect((await guard.verifyApproval(req)).permissionId).toBe(
      'permission-001'
    );
    expect(consume).toHaveBeenCalledWith(
      approvalId,
      creatorRequestHash(req.body),
      120
    );
    await expect(guard.verifyApproval(req)).rejects.toThrow(ForbiddenException);
  });

  it.each([
    { expiresAt: now },
    { expiresAt: now + 121 },
    { issuedAt: now + 1 },
    { issuedAt: now - 121 },
    { expiresAt: 'later' },
    { issuedAt: 1.5 },
    { reviewerEmail: 'creator@example.com' },
    { reviewerEmail: 1 },
    { permissionId: '' },
    { permissionId: ' ' },
    { mediaHash: '' },
    { mediaHash: 'b'.repeat(64) },
    { bodyHash: 'b'.repeat(64) },
    { orgId: 'different' },
    { method: 'PUT' },
    { path: '/posts' },
    { approvalId: '../other-key' },
    { v: 2 },
  ])('rejects mismatched or invalid approval fields: %j', async (changes) => {
    await expect(
      guard.verifyApproval(sign(request(), changes))
    ).rejects.toThrow(ForbiddenException);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each(['caption', 'account', 'media', 'date'])(
    'invalidates a changed %s before consuming the nonce',
    async (field) => {
      const req = sign(request());
      if (field === 'caption')
        req.body.posts[0].value[0].content = 'Changed meaning';
      if (field === 'account')
        req.body.posts[0].integration.id = 'another-account';
      if (field === 'media')
        req.body.posts[0].value[0].image[0].path =
          'https://other.example/video.mp4';
      if (field === 'date') req.body.date = '2030-01-01T00:00:00Z';
      await expect(guard.verifyApproval(req)).rejects.toThrow(
        ForbiddenException
      );
      expect(consume).not.toHaveBeenCalled();
    }
  );

  it.each([
    { type: 'schedule' },
    { type: 'update' },
    { inter: 1 },
    { inter: '1' },
  ])('rejects signed future/repeating operations: %j', async (change) => {
    const req = request();
    Object.assign(req.body, change);
    await expect(guard.verifyApproval(sign(req))).rejects.toThrow(
      ForbiddenException
    );
  });
  it('rejects a signed per-channel schedule override', async () => {
    const req = request();
    req.body.posts[0].date = '2030-01-01T00:00:00Z';
    await expect(guard.verifyApproval(sign(req))).rejects.toThrow(
      ForbiddenException
    );
  });
  it('fails closed for missing/wrong signing secrets, missing headers and unavailable replay storage', async () => {
    await expect(guard.verifyApproval(request())).rejects.toThrow(
      ForbiddenException
    );
    await expect(
      guard.verifyApproval(sign(request(), {}, 'wrong-secret'))
    ).rejects.toThrow(ForbiddenException);
    const signed = sign(request());
    delete process.env.CREATOR_PUBLISH_APPROVAL_SECRET;
    await expect(guard.verifyApproval(signed)).rejects.toThrow(
      ForbiddenException
    );
    process.env.CREATOR_PUBLISH_APPROVAL_SECRET = secret;
    const broken = new CreatorPublishingGuard(
      async () => {
        throw new Error('Redis down');
      },
      () => now
    );
    await expect(broken.verifyApproval(signed)).rejects.toThrow(
      ForbiddenException
    );
  });
  it('permits an explicitly reviewed text-only notice and validates every thumbnail hash', async () => {
    const req = request();
    req.body.posts[0].value[0].image = [];
    expect(creatorMediaHash(req.body)).toBe(creatorRequestHash([]));
    await expect(guard.verifyApproval(sign(req))).resolves.toBeDefined();
    const video = body();
    video.posts[0].value[0].image[0].thumbnail =
      'https://media.example/thumb.jpg';
    expect(() => creatorMediaHash(video)).toThrow(ForbiddenException);
    video.posts[0].value[0].image[0].thumbnailSha256 = 'b'.repeat(64);
    expect(creatorMediaHash(video)).toBe(
      creatorRequestHash([
        { path: video.posts[0].value[0].image[0].path, sha256: 'a'.repeat(64) },
        { path: 'https://media.example/thumb.jpg', sha256: 'b'.repeat(64) },
      ])
    );
  });
  it('preserves Unicode and array order while sorting object keys', () => {
    expect(canonicalCreatorJson({ z: [2, 1], a: 'Pilsēta' })).toBe(
      '{"a":"Pilsēta","z":[2,1]}'
    );
    expect(creatorRequestHash({ a: 1, b: 2 })).toBe(
      creatorRequestHash({ b: 2, a: 1 })
    );
    expect(() => creatorRequestHash({ n: Infinity })).toThrow(
      ForbiddenException
    );
  });
});

function context(controller: string, handler: string, req: any): any {
  return {
    getClass: () => ({ name: controller }),
    getHandler: () => ({ name: handler }),
    switchToHttp: () => ({ getRequest: () => req }),
  };
}

describe('Google-only creator and publisher route boundaries', () => {
  const originalEnv = { ...process.env };
  let orgs: any;
  let posts: any;
  let guard: PoliciesGuard;
  const creator = () => ({
    ...request(),
    user: { id: 'creator-id', email: 'creator@example.com' },
    org: { id: 'personal', users: [{ role: 'SUPERADMIN' }] },
    path: '/posts',
    body: { ...body(), type: 'draft' },
  });
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOOGLE_ONLY_AUTH: 'true',
      GOOGLE_AUTH_OWNER_EMAIL: owner,
      CREATOR_PUBLISHER_ORG_ID: 'official',
      REDIS_URL: 'redis://mocked',
    };
    orgs = {
      getTeam: jest.fn(async (id) => ({
        users:
          id === 'official'
            ? [
                {
                  user: { id: 'owner-id', email: owner },
                  role: 'SUPERADMIN',
                  disabled: false,
                },
              ]
            : [
                {
                  user: { id: 'creator-id', email: 'creator@example.com' },
                  role: 'SUPERADMIN',
                  disabled: false,
                },
              ],
      })),
    };
    posts = {
      getPost: jest.fn(async () => ({ posts: [{ state: 'DRAFT' }] })),
      getPostsByGroup: jest.fn(async () => ({ posts: [{ state: 'DRAFT' }] })),
    };
    guard = new PoliciesGuard({} as any, {} as any, orgs, posts);
    jest.mocked(ioRedis.set).mockReset().mockResolvedValue('OK');
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows a creator own-private-org draft, despite the legacy SUPERADMIN role', async () => {
    await expect(
      guard.canActivate(context('PostsController', 'createPost', creator()))
    ).resolves.toBe(true);
  });
  it.each([
    { group: undefined },
    { group: [] },
    { group: ['group'] },
    { group: '' },
    { group: '   ' },
  ])(
    'rejects a non-scalar or empty creator delete group: $group',
    async ({ group }) => {
      const req = { ...creator(), params: { group } };
      await expect(
        guard.canActivate(context('PostsController', 'deletePost', req))
      ).rejects.toThrow(ForbiddenException);
      expect(posts.getPostsByGroup).not.toHaveBeenCalled();
    }
  );
  it('checks a scalar creator delete group in the current private organisation', async () => {
    const req = { ...creator(), params: { group: 'group-id' } };
    await expect(
      guard.canActivate(context('PostsController', 'deletePost', req))
    ).resolves.toBe(true);
    expect(posts.getPostsByGroup).toHaveBeenCalledWith('personal', 'group-id');
  });
  it.each(['now', 'schedule', 'update'])(
    'rejects creator %s writes before existing subscription/provider bypasses',
    async (type) => {
      const req = creator();
      req.body.type = type;
      await expect(
        guard.canActivate(context('PostsController', 'createPost', req))
      ).rejects.toThrow(ForbiddenException);
    }
  );
  it.each([
    ['UsersController', 'rotateApiKey'],
    ['UsersController', 'joinOrg'],
    ['UsersController', 'changeOrg'],
    ['UsersController', 'setImpersonate'],
    ['SettingsController', 'inviteTeamMember'],
    ['SettingsController', 'addTeamMember'],
    ['IntegrationsController', 'getIntegrationList'],
    ['IntegrationsController', 'getSocialLogin'],
    ['NoAuthIntegrationsController', 'connectSocialMedia'],
    ['PostsController', 'generatePosts'],
    ['PostsController', 'changeDate'],
    ['AutopostController', 'create'],
    ['CopilotController', 'create'],
    ['PublicController', 'getPreview'],
    ['OAuthAuthorizedController', 'authorize'],
    ['MediaController', 'generateVideo'],
    ['MediaController', 'uploadFile'],
    ['MediaController', 'uploadServer'],
    ['MediaController', 'uploadSimple'],
    ['MediaController', 'deleteMedia'],
    ['MediaController', 'saveMediaInformation'],
  ])('rejects creator route %s.%s', async (controller, handler) => {
    await expect(
      guard.canActivate(context(controller, handler, creator()))
    ).rejects.toThrow(ForbiddenException);
  });
  it('denies official/shared/other-user organisations and missing publisher configuration', async () => {
    const req = creator();
    req.org.id = 'official';
    await expect(
      guard.canActivate(context('UsersController', 'getSelf', req))
    ).rejects.toThrow(ForbiddenException);
    req.org.id = 'other';
    orgs.getTeam.mockResolvedValue({ users: [{ user: { id: 'other-user' } }] });
    await expect(
      guard.canActivate(context('MediaController', 'getMedia', req))
    ).rejects.toThrow(ForbiddenException);
    req.org.id = 'personal';
    orgs.getTeam.mockResolvedValue({
      users: [
        { user: { id: 'creator-id' } },
        { user: { id: 'another-creator' } },
      ],
    });
    await expect(
      guard.canActivate(context('PostsController', 'getPosts', req))
    ).rejects.toThrow(ForbiddenException);
    delete process.env.CREATOR_PUBLISHER_ORG_ID;
    await expect(
      guard.canActivate(context('UsersController', 'getSelf', creator()))
    ).rejects.toThrow(ForbiddenException);
  });
  it('scopes every supplied existing post/group ID and refuses edits to queued submissions', async () => {
    const req = creator();
    req.body.posts[0].group = 'group';
    req.body.posts[0].value[0].id = 'post-id';
    await guard.canActivate(context('PostsController', 'createPost', req));
    expect(posts.getPost).toHaveBeenCalledWith('personal', 'post-id');
    expect(posts.getPostsByGroup).toHaveBeenCalledWith('personal', 'group');
    posts.getPost.mockResolvedValue({ posts: [{ state: 'QUEUE' }] });
    await expect(
      guard.canActivate(context('PostsController', 'createPost', req))
    ).rejects.toThrow(ForbiddenException);
    posts.getPost.mockRejectedValue(
      new ForbiddenException('Not found in current org')
    );
    await expect(
      guard.canActivate(context('PostsController', 'createPost', req))
    ).rejects.toThrow(ForbiddenException);
  });
  it('allows owner API-key requests without browser cookies, only for the owner-bound publisher organisation', async () => {
    const req = request();
    delete req.user;
    req.method = 'GET';
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'listIntegration', req)
      )
    ).resolves.toBe(true);
    req.org.id = 'personal';
    req.headers['showorg'] = 'official';
    req.headers['x-postiz-org'] = 'official';
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'listIntegration', req)
      )
    ).rejects.toThrow(ForbiddenException);
    req.org.id = 'official';
    orgs.getTeam.mockResolvedValue({
      users: [{ user: { email: 'creator@example.com' }, role: 'SUPERADMIN' }],
    });
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'listIntegration', req)
      )
    ).rejects.toThrow(ForbiddenException);
  });
  it('requires review for owner UI and API publishing, and closes legacy status/date/plugs bypasses', async () => {
    await expect(
      guard.canActivate(context('PostsController', 'createPost', request()))
    ).rejects.toThrow(ForbiddenException);
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'createPost', request())
      )
    ).rejects.toThrow(ForbiddenException);
    for (const [controller, handler] of [
      ['PostsController', 'changeDate'],
      ['PublicIntegrationsController', 'changePostStatus'],
      ['PublicIntegrationsController', 'updatePostSettings'],
      ['IntegrationsController', 'functionIntegration'],
      ['AutopostController', 'create'],
      ['CopilotController', 'create'],
    ])
      await expect(
        guard.canActivate(context(controller, handler, request()))
      ).rejects.toThrow(ForbiddenException);
  });

  it('dispatches a reviewed owner API request through the real one-use Redis adapter without a session cookie', async () => {
    process.env.NODE_ENV = 'test';
    process.env.CREATOR_PUBLISH_APPROVAL_SECRET = secret;
    delete process.env.CREATOR_PUBLISH_APPROVAL_SECRET_FILE;
    const current = Math.floor(Date.now() / 1000);
    const req = sign(request(), { issuedAt: current, expiresAt: current + 90 });
    delete req.user;
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'createPost', req)
      )
    ).resolves.toBe(true);
    expect(ioRedis.set).toHaveBeenCalledWith(
      'creator-publish-approval:' + approvalId,
      creatorRequestHash(req.body),
      'EX',
      expect.any(Number),
      'NX'
    );
    jest.mocked(ioRedis.set).mockResolvedValue(null);
    await expect(
      guard.canActivate(
        context('PublicIntegrationsController', 'createPost', req)
      )
    ).rejects.toThrow(ForbiddenException);
  });
});
