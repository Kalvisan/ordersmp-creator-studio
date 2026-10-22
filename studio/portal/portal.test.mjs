import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { PortalRepository } from './repository.mjs';
import { PortalService, authenticatePortal } from './service.mjs';
import { createPortalServer } from './server.mjs';

const actor = {
  id: 'creator-id',
  email: 'creator@example.com',
  owner: false,
  role: 'USER',
};
const owner = {
  id: 'owner-id',
  email: 'owner@example.com',
  owner: true,
  role: 'SUPERADMIN',
};
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from('ftypisom'),
  Buffer.alloc(24),
]);
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ordersmp-portal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new PortalRepository(join(directory, 'registry.json'));
  const service = new PortalService({
    repository,
    storageRoot: join(directory, 'media'),
    ownerEmail: owner.email,
    ...options,
  });
  await service.initialize();
  return { directory, repository, service };
}
function uploadRequest(data = mp4) {
  const stream = Readable.from([data]);
  stream.headers = { 'content-length': String(data.length) };
  return stream;
}

test('registry changes are atomic and stale versions cannot overwrite another review', async (t) => {
  const { repository, directory } = await setup(t);
  repository.put('drafts', 'one', { description: 'original' }, 0);
  repository.put('drafts', 'one', { description: 'reviewed' }, 1);
  assert.throws(
    () => repository.put('drafts', 'one', { description: 'stale' }, 1),
    /changed/
  );
  const snapshot = repository.read('drafts', 'one');
  snapshot.description = 'outside mutation';
  assert.equal(repository.read('drafts', 'one').description, 'reviewed');
  assert.throws(() =>
    repository.transaction((state) => {
      state.drafts.one.description = 'failed';
      throw new Error('stop');
    })
  );
  assert.equal(
    JSON.parse(await readFile(join(directory, 'registry.json'), 'utf8')).drafts
      .one.description,
    'reviewed'
  );
});
test('raw video upload streams into a random private file with measured checksum and owner isolation', async (t) => {
  const { service } = await setup(t);
  const source = await service.upload(
    actor,
    uploadRequest(),
    '../../recording.mp4'
  );
  assert.match(source.path, /^inbox\/[a-f0-9-]{36}$/);
  assert.equal(source.sha256, createHash('sha256').update(mp4).digest('hex'));
  assert.equal(source.size, mp4.length);
  assert.equal(service.sources(owner).length, 1);
  assert.throws(
    () => service.own({ ...actor, id: 'other' }, source.id),
    /not found/
  );
  assert.equal(service.sources({ ...actor, id: 'other' }).length, 0);
  assert.equal((await service.media(actor, source.id)).size, mp4.length);
});
test('oversized, invalid-format and aborted uploads leave no partial source or admission slot', async (t) => {
  const { service, directory } = await setup(t, { maxUploadBytes: 100 });
  await assert.rejects(
    service.upload(actor, uploadRequest(Buffer.alloc(101)), 'big.mp4'),
    /smaller/
  );
  await assert.rejects(
    service.upload(
      actor,
      uploadRequest(Buffer.from('not a video')),
      'fake.mp4'
    ),
    /Choose/
  );
  const broken = Readable.from(
    (async function* () {
      yield mp4;
      throw new Error('connection closed');
    })()
  );
  broken.headers = { 'content-length': '70' };
  await assert.rejects(
    service.upload(actor, broken, 'broken.mp4'),
    /connection closed/
  );
  assert.deepEqual(await readdir(join(directory, 'media', 'inbox')), []);
  assert.equal(service.uploads.size, 0);
  assert.equal(service.reserved, 0);
});
test('library cap rejects before accepting bytes and counts files left outside the registry', async (t) => {
  const { service, directory } = await setup(t, {
    storageLimitBytes: mp4.length,
  });
  await writeFile(join(directory, 'media', 'renders', 'orphan.mp4'), mp4);
  let consumed = false;
  const stream = Readable.from(
    (async function* () {
      consumed = true;
      yield mp4;
    })()
  );
  stream.headers = { 'content-length': String(mp4.length) };
  await assert.rejects(
    service.upload(actor, stream, 'new.mp4'),
    /library is full/
  );
  assert.equal(consumed, false);
  assert.equal(service.reserved, 0);
});
test('a creator explicitly records platform permission and can revoke it, another creator cannot', async (t) => {
  const { service } = await setup(t);
  const source = await service.upload(actor, uploadRequest(), 'source.mp4');
  assert.throws(
    () => service.permission(actor, source.id, { confirmed: false }),
    /Confirm/
  );
  const permission = service.permission(actor, source.id, {
    confirmed: true,
    editing: true,
    platforms: ['youtube', 'discord'],
    credit: 'Creator channel',
    creatorHandle: '@Creator',
    monetization: false,
  });
  assert.deepEqual(permission.platforms, ['youtube', 'discord']);
  assert.equal(permission.confirmedBy, actor.email);
  assert.throws(
    () => service.revokePermission({ ...actor, id: 'other' }, source.id),
    /not found/
  );
  assert.ok(service.revokePermission(actor, source.id).revokedAt);
});
test('worker claims once with a lease; completion requires active lease, confined paths and real media hashes', async (t) => {
  const { service, repository, directory } = await setup(t);
  const source = await service.upload(actor, uploadRequest(), 'source.mp4');
  service.permission(actor, source.id, { confirmed: true, editing: true,
    platforms: ['youtube'], credit: 'Creator channel', creatorHandle: '@b1oeorblue' });
  const queued = await service.prepare(actor, source.id, {
    markers: [{ start: 0, end: 20 }],
    language: 'en',
    creatorHandle: '@b1oeorblue',
  });
  const claimed = service.claimJob();
  assert.equal(claimed.id, queued.id);
  assert.equal(claimed.creatorHandle, '@b1oeorblue');
  assert.ok(claimed.leaseToken);
  assert.equal(service.claimJob(), null);
  const path = `${randomUUID()}.mp4`;
  await writeFile(join(directory, 'media', 'renders', path), mp4);
  const clip = {
    path,
    start: 0,
    end: 20,
    duration: 20,
    transcript: 'A real clip transcript.',
    sha256: createHash('sha256').update(mp4).digest('hex'),
    creatorHandle: '@b1oeorblue',
  };
  await assert.rejects(
    service.completeJob({ id: claimed.id, leaseToken: 'wrong', clips: [clip] }),
    /not active/
  );
  await assert.rejects(
    service.completeJob({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      clips: [{ ...clip, path: '../inbox/other.mp4' }],
    }),
    /Invalid/
  );
  await assert.rejects(
    service.completeJob({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      clips: [{ ...clip, creatorHandle: '@Wrong' }],
    }),
    /Invalid prepared clip/
  );
  await assert.rejects(
    service.completeJob({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      clips: [{ ...clip, sha256: '0'.repeat(64) }],
    }),
    /checksum/
  );
  await service.completeJob({
    id: claimed.id,
    leaseToken: claimed.leaseToken,
    clips: [clip],
  });
  assert.equal(repository.list('drafts').length, 1);
  assert.equal(repository.list('drafts')[0].creatorId, actor.id);
  assert.equal(repository.list('drafts')[0].media[0].creatorHandle, claimed.creatorHandle);
  assert.equal(repository.read('sources', source.id).clips[0].creatorHandle, claimed.creatorHandle);
  await assert.rejects(
    service.completeJob({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      clips: [clip],
    }),
    /not active/
  );
});
test('media confinement rejects dot segments even when they resolve inside the media root', async (t) => {
  const { service, directory } = await setup(t);
  await writeFile(join(directory, 'media', 'inbox', 'source'), mp4);
  await assert.rejects(
    service.safePath('renders/../inbox/source', 'renders'),
    /Invalid media path/
  );
});

test('on-screen credit rejects filter syntax and preparation must match saved permission', async (t) => {
  const { service } = await setup(t);
  const source = await service.upload(actor, uploadRequest(), 'source.mp4');
  const permission = { confirmed: true, editing: true, platforms: ['youtube'], credit: 'Video by creator' };
  for (const creatorHandle of [undefined, '', '@', '@bad:drawtext', '@bad\nextra', '@' + 'a'.repeat(41), 'creator']) {
    assert.throws(() => service.permission(actor, source.id, { ...permission, creatorHandle }), /on-screen credit/);
    await assert.rejects(service.prepare(actor, source.id, { markers: [], creatorHandle }), /on-screen credit/);
  }
  await assert.rejects(service.prepare(actor, source.id, { markers: [], creatorHandle: '@Creator' }), /Save permission/);
  const saved = service.permission(actor, source.id, { ...permission, creatorHandle: ' @Creator.One-2_3 ' });
  assert.equal(saved.creatorHandle, '@Creator.One-2_3');
  await assert.rejects(service.prepare(actor, source.id, { markers: [], creatorHandle: '@Other' }), /Save permission/);
  assert.equal((await service.prepare(actor, source.id, { markers: [], creatorHandle: saved.creatorHandle })).creatorHandle, saved.creatorHandle);
});
test('browser identity comes only from the fixed backend Google session, never supplied identity headers', async () => {
  let target, options;
  const identity = await authenticatePortal(
    {
      headers: {
        cookie: 'auth=signed-google-session',
        'x-user-email': owner.email,
        authorization: 'Bearer untrusted',
      },
    },
    {
      backendUrl: 'http://127.0.0.1:3000',
      ownerEmail: owner.email,
      fetchImpl: async (url, input) => {
        target = String(url);
        options = input;
        return Response.json({
          id: actor.id,
          email: actor.email,
          role: 'USER',
        });
      },
    }
  );
  assert.equal(target, 'http://127.0.0.1:3000/user/self');
  assert.deepEqual(options.headers, { cookie: 'auth=signed-google-session' });
  assert.equal(identity.owner, false);
  assert.equal(identity.email, actor.email);
  await assert.rejects(
    authenticatePortal(
      { headers: {} },
      { backendUrl: 'http://127.0.0.1:3000', ownerEmail: owner.email }
    ),
    /Sign in/
  );
});
test('real HTTP routes require Google session, exact write Origin and separate worker token', async (t) => {
  const state = await setup(t);
  const tokenFile = join(state.directory, 'worker-token');
  await writeFile(tokenFile, 'a'.repeat(48));
  const { server } = await createPortalServer({
    ...state,
    registryFile: join(state.directory, 'registry.json'),
    storageRoot: state.service.storageRoot,
    backendUrl: 'http://127.0.0.1:3000',
    frontendUrl: 'https://studio.example.com',
    ownerEmail: owner.email,
    workerTokenFile: tokenFile,
    fetchImpl: async (url, options) =>
      options.headers.cookie === 'auth=valid'
        ? Response.json({ id: actor.id, email: actor.email, role: 'USER' })
        : new Response('', { status: 401 }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/creator/api/session`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/creator/api/sources`, {
        method: 'POST',
        headers: {
          cookie: 'auth=valid',
          origin: 'https://attacker.example',
          'content-type': 'application/octet-stream',
        },
        body: mp4,
      })
    ).status,
    403
  );
  const upload = await fetch(`${base}/creator/api/sources?name=test.mp4`, {
    method: 'POST',
    headers: {
      cookie: 'auth=valid',
      origin: 'https://studio.example.com',
      'content-type': 'application/octet-stream',
    },
    body: mp4,
  });
  assert.equal(upload.status, 201);
  const source = await upload.json();
  const media = await fetch(`${base}/creator/api/sources/${source.id}/media`, {
    headers: { cookie: 'auth=valid', range: 'bytes=0-7' },
  });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 8);
  assert.equal(
    (
      await fetch(`${base}/creator/internal/jobs`, {
        headers: { cookie: 'auth=valid' },
      })
    ).status,
    401
  );
  assert.equal(
    (
      await fetch(`${base}/creator/internal/jobs`, {
        headers: { authorization: `Bearer ${'a'.repeat(48)}` },
      })
    ).status,
    200
  );
  const mcp = await fetch(`${base}/creator/mcp`, { method: 'POST' });
  assert.equal(mcp.status, 503);
  assert.match((await mcp.json()).error, /not configured/);
});

test('public media HTTP serves only the approved resolver path with bounded streams and ranges', async (t) => {
  const state = await setup(t);
  const filename = join(state.directory, 'frozen.mp4');
  await writeFile(filename, mp4);
  const basename = `${'a'.repeat(64)}.mp4`;
  let admitted = true;
  let hold = false;
  let resolverCalls = 0;
  const pending = [];
  let allStarted;
  const started = new Promise((resolve) => { allStarted = resolve; });
  const { server, controller } = await createPortalServer({
    ...state,
    storageRoot: state.service.storageRoot,
    frontendUrl: 'https://studio.example.com',
    ownerEmail: owner.email,
    fetchImpl: async () => { throw new Error('Public media must not query cookie identity'); },
    publishing: {
      async resolvePublicMedia(name) {
        resolverCalls++;
        assert.equal(name, basename);
        if (!admitted) throw Object.assign(new Error('Page not found'), { status: 404 });
        if (hold) await new Promise((resolve) => {
          pending.push(resolve);
          if (pending.length === 8) allStarted();
        });
        return { filename, size: mp4.length };
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    pending.forEach((release) => release());
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}/creator-media/`;
  const head = await fetch(base + basename, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), String(mp4.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(base + basename, { headers: { range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${mp4.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), mp4.subarray(0, 8));
  assert.equal((await fetch(base + basename, { headers: { range: 'bytes=0-1,3-4' } })).status, 416);
  const calls = resolverCalls;
  for (const path of ['original.mp4', `${'A'.repeat(64)}.mp4`, `${basename}/extra`])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + basename, { method: 'POST' })).status, 404);
  assert.equal(resolverCalls, calls);
  admitted = false;
  assert.equal((await fetch(base + basename)).status, 404);
  admitted = true;
  hold = true;
  const abort = new AbortController();
  const streams = Array.from({ length: 8 }, (_, index) => fetch(base + basename,
    index === 0 ? { signal: abort.signal } : {}));
  await started;
  abort.abort();
  await assert.rejects(streams[0], { name: 'AbortError' });
  // An aborted caller still occupies its slot until verification finishes.
  assert.equal(controller.publicStreams, 8);
  const overflow = await fetch(base + basename);
  assert.equal(overflow.status, 429);
  assert.equal(overflow.headers.get('retry-after'), '5');
  pending.forEach((release) => release());
  await Promise.all(streams.slice(1).map(async (request) => {
    const response = await request;
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }));
  assert.equal(controller.publicStreams, 0);
});
