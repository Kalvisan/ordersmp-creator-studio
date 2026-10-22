import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalRepository } from '../portal/repository.mjs';
import { createPublishingService } from './service.mjs';
import {
  canonicalJson,
  hashJson,
  mediaHash,
  signApproval,
} from './protocol.mjs';

export async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ordersmp-publishing-'));
  t.after(async () => {
    await chmod(join(root, 'approved'), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'renders'));
  const bytes = Buffer.from('registered worker output');
  const media = {
    path: `renders/${randomUUID()}.mp4`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mime: 'video/mp4',
    creatorHandle: '@Creator',
  };
  await writeFile(join(root, media.path), bytes);
  const apiKeyFile = join(root, 'api-key'),
    approvalSecretFile = join(root, 'approval-key');
  await writeFile(apiKeyFile, 'a'.repeat(48));
  await writeFile(approvalSecretFile, 's'.repeat(48));
  const repository = new PortalRepository(join(root, 'registry.json'));
  const sourceId = randomUUID(),
    clipId = randomUUID(),
    permissionId = randomUUID();
  const actor = {
    id: 'creator',
    email: 'creator@example.com',
    role: 'SUPERADMIN',
    owner: false,
  };
  const owner = {
    id: 'owner',
    email: 'owner@example.com',
    role: 'SUPERADMIN',
    owner: true,
  };
  repository.put(
    'sources',
    sourceId,
    {
      creatorId: actor.id,
      creatorEmail: actor.email,
      title: 'Minecraft clip',
      permissionId,
      clips: [
        {
          ...media,
          id: clipId,
          transcript: 'We found the base.',
          start: 0,
          end: 20,
        },
      ],
    },
    0
  );
  repository.put(
    'permissions',
    permissionId,
    {
      creatorId: actor.id,
      creatorEmail: actor.email,
      sourceId,
      platforms: ['youtube', 'instagram', 'discord', 'tiktok'],
      editing: true,
      monetization: false,
      credit: 'Video: Creator',
      creatorHandle: '@Creator',
      confirmedBy: actor.email,
      revokedAt: null,
    },
    0
  );
  const clock = { value: Date.parse('2026-10-23T12:00:00.000Z') };
  const calls = [];
  const network = {
    post: async () => Response.json([{ postId: 'native-post' }]),
    accounts: [
      { id: 'youtube-account', identifier: 'youtube', name: 'OrderSMP' },
      { id: 'tiktok-account', identifier: 'tiktok', name: 'TikTok' },
      { id: 'discord-account', identifier: 'discord', name: 'Discord' },
      {
        id: 'instagram-account',
        identifier: 'instagram-standalone',
        name: 'Instagram',
      },
    ],
    published: false,
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), ...options });
    const path = new URL(url).pathname;
    if (path.endsWith('/me'))
      return Response.json({ organization: { id: 'official-org' } });
    if (path.endsWith('/integrations')) return Response.json(network.accounts);
    if (options.method === 'POST') return network.post(options);
    if (path.endsWith('/posts'))
      return Response.json({
        posts: [
          {
            id: 'native-post',
            state: network.published ? 'PUBLISHED' : 'QUEUE',
            releaseURL: network.published
              ? 'https://youtube.com/watch?v=test'
              : null,
          },
        ],
      });
    throw new Error('Unexpected network request');
  };
  const service = createPublishingService({
    repository,
    storageRoot: root,
    approvedMediaRoot: join(root, 'approved'),
    publicMediaBaseUrl: 'https://media.example.com/clips/',
    postizBaseUrl: 'http://127.0.0.1:3000',
    publisherOrgId: 'official-org',
    ownerEmail: owner.email,
    apiKeyFile,
    approvalSecretFile,
    fetchImpl,
    now: () => clock.value,
    allowedDiscordChannels: ['123456789012345678'],
    ...extra,
  });
  const draft = service.createDraft(actor, { sourceId, clipId });
  const approval = (overrides = {}) => ({
    version: draft.version,
    dueAt: new Date(clock.value).toISOString(),
    rightsConfirmed: true,
    destinations: [
      {
        platform: 'youtube',
        accountId: 'youtube-account',
        settings: {
          title: 'Minecraft discovery',
          type: 'private',
          selfDeclaredMadeForKids: 'no',
          tags: ['Minecraft'],
        },
      },
    ],
    ...overrides,
  });
  return {
    root,
    service,
    repository,
    actor,
    owner,
    sourceId,
    clipId,
    permissionId,
    draft,
    media,
    clock,
    calls,
    network,
    approval,
    apiKeyFile,
    approvalSecretFile,
  };
}

test('signer uses canonical UTF-8 JSON and the exact native guard protocol', async (t) => {
  const f = await fixture(t);
  assert.equal(
    canonicalJson({ z: ['ā', { b: 1, a: 2 }], a: true }),
    '{"a":true,"z":["ā",{"a":2,"b":1}]}'
  );
  assert.throws(() => canonicalJson({ a: undefined }));
  const body = {
    posts: [
      {
        value: [
          { image: [{ path: 'https://x/a.mp4', sha256: 'b'.repeat(64) }] },
        ],
      },
    ],
  };
  const signature = await signApproval({
    body,
    orgId: 'official-org',
    permissionId: f.permissionId,
    reviewerEmail: f.owner.email,
    secretFile: f.approvalSecretFile,
    now: f.clock.value,
  });
  const [encoded, mac] = signature.split('.');
  assert.equal(
    mac,
    createHmac('sha256', 's'.repeat(48)).update(encoded).digest('base64url')
  );
  const claims = JSON.parse(Buffer.from(encoded, 'base64url'));
  assert.equal(claims.path, '/public/v1/posts');
  assert.equal(claims.method, 'POST');
  assert.equal(claims.expiresAt - claims.issuedAt, 120);
  assert.equal(claims.bodyHash, hashJson(body));
  assert.equal(claims.mediaHash, mediaHash(body));
});

test('only the owner with an actual owner role can review publication', async (t) => {
  const f = await fixture(t);
  for (const actor of [
    f.actor,
    { ...f.owner, role: 'USER' },
    { ...f.owner, email: 'impostor@example.com' },
    { ...f.owner, owner: false },
  ])
    await assert.rejects(
      f.service.approveAndSchedule(actor, f.draft.id, f.approval()),
      /Only the channel owner/
    );
  assert.equal(f.repository.list('deliveries').length, 0);
});

test('creators cannot read, edit or clone another creator recording', async (t) => {
  const f = await fixture(t);
  const stranger = { id: 'other', owner: false };
  assert.deepEqual(f.service.listDrafts(stranger), []);
  assert.throws(
    () =>
      f.service.updateDraft(stranger, {
        draftId: f.draft.id,
        version: 1,
        title: 'x',
        description: 'x',
      }),
    /not found/
  );
  assert.throws(
    () =>
      f.service.createDraft(stranger, {
        sourceId: f.sourceId,
        clipId: f.clipId,
      }),
    /not found/
  );
});

test('review freezes bytes, schedules locally and signs only when due', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(
    f.owner,
    f.draft.id,
    f.approval({ dueAt: new Date(f.clock.value + 60000).toISOString() })
  );
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  const frozen = join(f.root, 'approved', `${f.media.sha256}.mp4`);
  assert.equal((await readFile(frozen)).toString(), 'registered worker output');
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'scheduled');
  f.clock.value += 60000;
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'processing');
  const write = f.calls.find((call) => call.method === 'POST');
  const body = JSON.parse(write.body),
    claims = JSON.parse(
      Buffer.from(
        write.headers['X-Creator-Publish-Approval'].split('.')[0],
        'base64url'
      )
    );
  assert.equal(write.headers.Authorization, 'a'.repeat(48));
  assert.equal(body.type, 'now');
  assert.equal(body.posts[0].settings.type, 'private');
  assert.equal(
    body.posts[0].value[0].content,
    'We found the base.\n\nVideo: Creator'
  );
  assert.equal(claims.bodyHash, hashJson(body));
  assert.equal(claims.mediaHash, mediaHash(body));
  assert.equal(claims.issuedAt, Math.floor(f.clock.value / 1000));
  f.network.published = true;
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'published');
});

for (const tamper of [
  'permission revoked',
  'permission changed',
  'draft changed',
  'delivery changed',
  'frozen bytes changed',
])
  test(`dispatch blocks when ${tamper}`, async (t) => {
    const f = await fixture(t);
    await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
    if (tamper.startsWith('permission')) {
      const permission = f.repository.read('permissions', f.permissionId);
      f.repository.put(
        'permissions',
        permission.id,
        {
          ...permission,
          ...(tamper.includes('revoked')
            ? { revokedAt: new Date().toISOString() }
            : { credit: 'new credit' }),
        },
        permission.version
      );
    }
    if (tamper === 'draft changed') {
      const draft = f.repository.read('drafts', f.draft.id);
      f.repository.put(
        'drafts',
        draft.id,
        { ...draft, description: 'new caption' },
        draft.version
      );
    }
    if (tamper === 'delivery changed') {
      const delivery = f.repository.list('deliveries')[0];
      delivery.body.posts[0].integration.id = 'other-account';
      f.repository.put('deliveries', delivery.id, delivery, delivery.version);
    }
    if (tamper === 'frozen bytes changed') {
      const path = join(f.root, 'approved', `${f.media.sha256}.mp4`);
      await chmod(path, 0o600);
      await writeFile(path, 'altered');
    }
    await f.service.tick();
    assert.equal(f.repository.list('deliveries')[0].status, 'blocked');
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  });

test('uncertain provider writes and restart recovery never retry automatically', async (t) => {
  const f = await fixture(t);
  f.network.post = async () => {
    throw new Error('timeout');
  };
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'uncertain');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  const delivery = f.repository.list('deliveries')[0];
  f.repository.put(
    'deliveries',
    delivery.id,
    { ...delivery, status: 'dispatching' },
    delivery.version
  );
  f.service.recovered = false;
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'uncertain');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('accepted responses are not labelled published until a platform URL exists', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'processing');
  f.clock.value += 3600001;
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'uncertain');
});

test('missed schedules require review instead of a catch-up burst', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  f.clock.value += 16 * 60000;
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'missed_review');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('cancellation stops local schedules and enables a new caption review', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  assert.throws(
    () =>
      f.service.updateDraft(f.owner, {
        draftId: f.draft.id,
        version: 2,
        title: 'New',
        description: 'New',
      }),
    /Cancel/
  );
  assert.throws(
    () => f.service.cancel(f.actor, f.draft.id),
    /Only the channel owner/
  );
  assert.equal(f.service.cancel(f.owner, f.draft.id).status, 'draft');
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'cancelled');
});

test('cancelling an accepted request requires manual platform confirmation', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  await f.service.tick();
  assert.equal(f.service.cancel(f.owner, f.draft.id).status, 'cancel_review');
  assert.equal(f.repository.list('deliveries')[0].cancelRequested, true);
});

test('TikTok remains manual and no automatic publication is silently enabled', async (t) => {
  const f = await fixture(t);
  const accounts = await f.service.listIntegrations();
  assert.equal(
    accounts.find((account) => account.platform === 'tiktok').manualRequired,
    true
  );
  await assert.rejects(
    f.service.approveAndSchedule(
      f.owner,
      f.draft.id,
      f.approval({
        destinations: [
          { platform: 'tiktok', accountId: 'tiktok-account', settings: {} },
        ],
      })
    ),
    /Manual handoff/
  );
  assert.equal(f.repository.list('deliveries').length, 0);
});

test('explicit YouTube audience/visibility and exact account-platform match are required', async (t) => {
  const f = await fixture(t);
  for (const destination of [
    {
      platform: 'youtube',
      accountId: 'youtube-account',
      settings: { title: 'Title', type: 'private' },
    },
    {
      platform: 'youtube',
      accountId: 'youtube-account',
      settings: { title: 'Title', selfDeclaredMadeForKids: 'no' },
    },
    {
      platform: 'instagram',
      accountId: 'youtube-account',
      settings: { post_type: 'post' },
    },
    {
      platform: 'youtube',
      accountId: 'youtube-account',
      settings: {
        title: 'Title',
        type: 'private',
        selfDeclaredMadeForKids: 'no',
        thumbnail: { path: 'https://unreviewed.test/a.png' },
      },
    },
  ])
    await assert.rejects(
      f.service.approveAndSchedule(
        f.owner,
        f.draft.id,
        f.approval({ destinations: [destination] })
      )
    );
});

test('Discord blocks unlisted channels and notification mentions', async (t) => {
  const f = await fixture(t);
  const destination = (channel) => ({
    platform: 'discord',
    accountId: 'discord-account',
    settings: { channel },
  });
  await assert.rejects(
    f.service.approveAndSchedule(
      f.owner,
      f.draft.id,
      f.approval({ destinations: [destination('123456789012345679')] })
    ),
    /approved Discord/
  );
  const changed = f.service.updateDraft(f.actor, {
    draftId: f.draft.id,
    version: 1,
    title: 'Clip',
    description: '@everyone new video',
  });
  await assert.rejects(
    f.service.approveAndSchedule(
      f.owner,
      f.draft.id,
      f.approval({
        version: changed.version,
        destinations: [destination('123456789012345678')],
      })
    ),
    /mentions/
  );
});

test('changed original bytes cannot enter the public approved library', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, f.media.path), 'tampered');
  await assert.rejects(
    f.service.approveAndSchedule(f.owner, f.draft.id, f.approval()),
    /video changed/
  );
  assert.equal(f.repository.list('deliveries').length, 0);
});

test('concurrent owner reviews cannot approve a stale draft twice', async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.service.approveAndSchedule(f.owner, f.draft.id, f.approval()),
    f.service.approveAndSchedule(f.owner, f.draft.id, f.approval()),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  assert.equal(f.repository.list('deliveries').length, 1);
});

test('multi-platform approvals keep separate delivery results', async (t) => {
  const f = await fixture(t);
  const input = f.approval();
  input.destinations.push({
    platform: 'instagram',
    accountId: 'instagram-account',
    settings: { post_type: 'post' },
  });
  await f.service.approveAndSchedule(f.owner, f.draft.id, input);
  await f.service.tick();
  assert.equal(f.repository.list('deliveries').length, 2);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
});

test('permission revoked during destination checks is blocked at the dispatch boundary', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  const original = f.service.fetchImpl;
  f.service.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    if (new URL(url).pathname.endsWith('/integrations')) {
      const permission = f.repository.read('permissions', f.permissionId);
      f.repository.put(
        'permissions',
        permission.id,
        { ...permission, revokedAt: new Date().toISOString() },
        permission.version
      );
    }
    return response;
  };
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'blocked');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('portal drafts work before the owner workspace has been connected', async (t) => {
  const f = await fixture(t, {
    publisherOrgId: undefined,
    publicMediaBaseUrl: undefined,
  });
  assert.equal(f.service.listDrafts(f.actor).length, 1);
  await assert.rejects(f.service.listIntegrations(), /finish connecting/);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
});

test('missing publisher key leaves private draft processing available and publication closed', async (t) => {
  const f = await fixture(t, {
    publisherOrgId: undefined,
    apiKeyFile: undefined,
  });
  assert.equal(f.service.setupReady(), false);
  const updated = f.service.updateDraft(f.actor, {
    draftId: f.draft.id,
    version: 1,
    title: 'Edited privately',
    description: 'Ready for later review',
  });
  assert.equal(updated.title, 'Edited privately');
  assert.equal(
    f.service.createDraft(f.actor, { sourceId: f.sourceId, clipId: f.clipId })
      .status,
    'draft'
  );
  await assert.rejects(
    f.service.listIntegrations(),
    (error) => error.status === 503 && /finish connecting/.test(error.message)
  );
  await assert.rejects(
    f.service.approveAndSchedule(f.owner, f.draft.id, f.approval()),
    (error) => error.status === 503 && /finish connecting/.test(error.message)
  );
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.list('deliveries').length, 0);
});

test('missing publisher key file reports setup failure without an outbound request', async (t) => {
  const f = await fixture(t, {
    apiKeyFile: join(tmpdir(), `missing-${randomUUID()}`),
  });
  await assert.rejects(
    f.service.listIntegrations(),
    (error) => error.status === 503 && /finish connecting/.test(error.message)
  );
  assert.equal(f.calls.length, 0);
});

test('review refuses to exceed the recording library storage limit', async (t) => {
  const f = await fixture(t, { storageLimitBytes: 1 });
  await assert.rejects(
    f.service.approveAndSchedule(f.owner, f.draft.id, f.approval()),
    /library is full/
  );
  assert.equal(f.repository.list('approvals').length, 0);
});

test('approval preserves and binds the exact rendered creator handle', async (t) => {
  const f = await fixture(t);
  assert.equal(f.draft.media[0].creatorHandle, '@Creator');
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  const approval = f.repository.list('approvals')[0];
  assert.equal(approval.snapshot.permission.creatorHandle, '@Creator');
  assert.equal(approval.snapshot.draft.media[0].creatorHandle, '@Creator');
  assert.equal(approval.snapshot.media[0].creatorHandle, '@Creator');
});

for (const handle of [
  undefined,
  '@OtherCreator',
  '@creator',
  ' @Creator',
  '@bad:filter',
  '@bad%{expr}',
  '@' + 'x'.repeat(41),
])
  test(`approval rejects an uncredited or mismatched render: ${String(
    handle
  )}`, async (t) => {
    const f = await fixture(t);
    const draft = f.repository.read('drafts', f.draft.id);
    if (handle === undefined) delete draft.media[0].creatorHandle;
    else draft.media[0].creatorHandle = handle;
    const changed = f.repository.put('drafts', draft.id, draft, draft.version);
    await assert.rejects(
      f.service.approveAndSchedule(
        f.owner,
        draft.id,
        f.approval({ version: changed.version })
      ),
      (error) => error.status === 409 && /burned into/.test(error.message)
    );
    assert.equal(f.repository.list('approvals').length, 0);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  });

test('legacy clips without burned-credit metadata remain draft-only after a handle is set', async (t) => {
  const f = await fixture(t);
  const source = f.repository.read('sources', f.sourceId);
  delete source.clips[0].creatorHandle;
  f.repository.put('sources', source.id, source, source.version);
  const draft = f.service.createDraft(f.actor, {
    sourceId: source.id,
    clipId: f.clipId,
  });
  assert.equal(Object.hasOwn(draft.media[0], 'creatorHandle'), false);
  await assert.rejects(
    f.service.approveAndSchedule(f.owner, draft.id, f.approval()),
    /burned into/
  );
});

test('malformed permission handle is rejected even when render metadata copies it', async (t) => {
  const f = await fixture(t);
  const permission = f.repository.read('permissions', f.permissionId);
  f.repository.put(
    'permissions',
    permission.id,
    { ...permission, creatorHandle: '@Creator:drawtext' },
    permission.version
  );
  const draft = f.repository.read('drafts', f.draft.id);
  draft.media[0].creatorHandle = '@Creator:drawtext';
  const changed = f.repository.put('drafts', draft.id, draft, draft.version);
  await assert.rejects(
    f.service.approveAndSchedule(
      f.owner,
      draft.id,
      f.approval({ version: changed.version })
    ),
    /burned into/
  );
});

test('a trailing newline cannot make a stored creator handle appear canonical', async (t) => {
  const f = await fixture(t);
  const permission = f.repository.read('permissions', f.permissionId);
  f.repository.put(
    'permissions',
    permission.id,
    { ...permission, creatorHandle: '@Creator\n' },
    permission.version
  );
  const draft = f.repository.read('drafts', f.draft.id);
  draft.media[0].creatorHandle = '@Creator\n';
  const changed = f.repository.put('drafts', draft.id, draft, draft.version);
  await assert.rejects(
    f.service.approveAndSchedule(
      f.owner,
      draft.id,
      f.approval({ version: changed.version })
    ),
    /burned into/
  );
});

test('changing the permission handle after approval blocks dispatch and public fetch', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  const permission = f.repository.read('permissions', f.permissionId);
  f.repository.put(
    'permissions',
    permission.id,
    { ...permission, creatorHandle: '@UpdatedCreator' },
    permission.version
  );
  await f.service.tick();
  assert.equal(f.repository.list('deliveries')[0].status, 'blocked');
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  await assert.rejects(
    f.service.resolvePublicMedia(`${f.media.sha256}.mp4`),
    (error) => error.status === 404
  );
});

test('public media is available during reviewed dispatch and returns only file and size', async (t) => {
  const f = await fixture(t, {
    publicMediaBaseUrl: 'https://ordersmp.net/creator-media/',
  });
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  await assert.rejects(
    f.service.resolvePublicMedia(`${f.media.sha256}.mp4`),
    (error) => error.status === 404
  );
  let observed;
  f.network.post = async () => {
    observed = await f.service.resolvePublicMedia(`${f.media.sha256}.mp4`);
    return Response.json([{ postId: 'native-post' }]);
  };
  await f.service.tick();
  assert.deepEqual(observed, {
    filename: join(f.root, 'approved', `${f.media.sha256}.mp4`),
    size: f.media.size,
  });
  assert.deepEqual(Object.keys(observed).sort(), ['filename', 'size']);
  assert.equal(
    (await f.service.resolvePublicMedia(`${f.media.sha256}.mp4`)).size,
    f.media.size
  );
});

for (const change of [
  'withdrawn',
  'permission version',
  'expiry',
  'too early',
  'cancelled',
  'unapproved',
  'changed bytes',
  'changed content',
])
  test(`public media denies ${change}`, async (t) => {
    const f = await fixture(t);
    await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
    await f.service.tick();
    if (change === 'withdrawn' || change === 'permission version') {
      const permission = f.repository.read('permissions', f.permissionId);
      f.repository.put(
        'permissions',
        permission.id,
        {
          ...permission,
          ...(change === 'withdrawn'
            ? { revokedAt: new Date().toISOString() }
            : {}),
        },
        permission.version
      );
    }
    if (change === 'expiry') f.clock.value += 48 * 3600000;
    if (change === 'too early') f.clock.value -= 6 * 60000;
    if (change === 'cancelled') {
      const delivery = f.repository.list('deliveries')[0];
      f.repository.put(
        'deliveries',
        delivery.id,
        { ...delivery, status: 'cancelled' },
        delivery.version
      );
    }
    if (change === 'unapproved')
      f.repository.transaction((state) => {
        state.approvals = {};
      });
    if (change === 'changed bytes') {
      const path = join(f.root, 'approved', `${f.media.sha256}.mp4`);
      await chmod(path, 0o600);
      await writeFile(path, Buffer.alloc(f.media.size, 1));
    }
    if (change === 'changed content') {
      const draft = f.repository.read('drafts', f.draft.id);
      f.repository.put(
        'drafts',
        draft.id,
        { ...draft, description: 'Changed caption' },
        draft.version
      );
    }
    await assert.rejects(
      f.service.resolvePublicMedia(`${f.media.sha256}.mp4`),
      (error) => error.status === 404 && error.message === 'Video not found'
    );
  });

test('public media rejects traversal, unknown hashes and original recordings', async (t) => {
  const f = await fixture(t);
  await f.service.approveAndSchedule(f.owner, f.draft.id, f.approval());
  await f.service.tick();
  for (const filename of [
    '../inbox/source.mp4',
    `${f.media.sha256}.mp4/../file`,
    `${'f'.repeat(64)}.mp4`,
    f.media.path,
    `${f.media.sha256.toUpperCase()}.mp4`,
    `${f.media.sha256}.mp4?token=x`,
  ])
    await assert.rejects(
      f.service.resolvePublicMedia(filename),
      (error) => error.status === 404
    );
});
