import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  link,
  rename,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortalRepository } from './repository.mjs';
import { PortalService } from './service.mjs';
import { createPortalServer } from './server.mjs';

const owner = {
  id: 'owner',
  email: 'owner@example.com',
  role: 'SUPERADMIN',
  owner: true,
};
const creator = {
  id: 'creator',
  email: 'creator@example.com',
  role: 'SUPERADMIN',
  owner: false,
};
const relative = `2026/10/24/${'a'.repeat(32)}.png`;
const image = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(64, 1),
]);

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ordersmp-native-uploads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'postiz-uploads');
  await mkdir(join(root, '2026', '10', '24'), { recursive: true });
  await writeFile(join(root, relative), image);
  const repository = new PortalRepository(join(directory, 'registry.json'));
  const service = new PortalService({
    repository,
    storageRoot: join(directory, 'media'),
    postizUploadRoot: root,
    ownerEmail: owner.email,
  });
  await service.initialize();
  return { directory, root, repository, service };
}

test('native media requires exact owner identity, role and a registered current-org path', async (t) => {
  const { service } = await setup(t);
  let calls = 0;
  const lookup = async (path) => {
    calls++;
    assert.equal(path, relative);
    return true;
  };
  for (const actor of [
    creator,
    { ...owner, role: 'USER' },
    { ...owner, email: 'impostor@example.com' },
  ])
    await assert.rejects(
      service.nativeUpload(actor, relative, lookup),
      (error) => error.status === 403
    );
  assert.equal(calls, 0);
  const file = await service.nativeUpload(owner, relative, lookup);
  assert.equal(file.size, image.length);
  assert.equal(file.mime, 'image/png');
  await file.handle.close();
  await assert.rejects(
    service.nativeUpload(owner, relative, async () => false),
    (error) => error.status === 404
  );
});

test('native streams keep the verified descriptor after a dated folder is swapped', async (t) => {
  const { service, directory, root } = await setup(t);
  const file = await service.nativeUpload(owner, relative, async () => true);
  try {
    const outside = join(directory, 'private');
    await mkdir(outside);
    await writeFile(join(outside, `${'a'.repeat(32)}.png`), 'DUMMY-PRIVATE');
    const dated = join(root, '2026', '10', '24');
    try {
      await rename(dated, `${dated}-original`);
    } catch (error) {
      // Windows refuses an ancestor rename while its file descriptor is open.
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      assert.deepEqual(await file.handle.readFile(), image);
      t.diagnostic(
        'Windows held descriptor prevents ancestor rename; Linux exercises post-open swap'
      );
      return;
    }
    await symlink(
      outside,
      dated,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    assert.deepEqual(await file.handle.readFile(), image);
    await assert.rejects(
      service.nativeUpload(owner, relative, async () => true),
      (error) => error.status === 404
    );
  } finally {
    await file.handle.close();
  }
});

test('native media rejects non-native names, traversal, unsafe types and absent configuration', async (t) => {
  const { service } = await setup(t);
  for (const path of [
    '../config/service.env',
    '/2026/10/24/file.png',
    '2026/10/24/../../../secrets',
    relative.replace('.png', '.svg'),
    relative.replace('.png', '.html'),
    relative.replace('a'.repeat(32), 'a'.repeat(31)),
    relative + '\n',
    relative + '?x=y',
    relative.replaceAll('/', '\\'),
  ])
    await assert.rejects(
      service.nativeUpload(owner, path, async () => true),
      (error) => error.status === 404
    );
  service.postizUploadRoot = null;
  await assert.rejects(
    service.nativeUpload(owner, relative, async () => true),
    (error) => error.status === 503
  );
});

test('native confinement rejects final symlinks, linked folders and hard links', async (t) => {
  const { service, directory, root } = await setup(t);
  const outside = join(directory, 'outside.png');
  await writeFile(outside, image);
  const linked = relative.replace('a'.repeat(32), 'b'.repeat(32));
  try {
    await symlink(outside, join(root, linked));
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  await assert.rejects(
    service.nativeUpload(owner, linked, async () => true),
    (error) => error.status === 404
  );
  const folder = join(directory, 'outside-folder');
  await mkdir(folder);
  await writeFile(join(folder, `${'a'.repeat(32)}.png`), image);
  try {
    await symlink(
      folder,
      join(root, '2026', '10', '25'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  await assert.rejects(
    service.nativeUpload(
      owner,
      relative.replace('/24/', '/25/'),
      async () => true
    ),
    (error) => error.status === 404
  );
  const hard = relative.replace('a'.repeat(32), 'c'.repeat(32));
  await link(outside, join(root, hard));
  await assert.rejects(
    service.nativeUpload(owner, hard, async () => true),
    (error) => error.status === 404
  );
});

async function httpSetup(t) {
  const state = await setup(t),
    lookups = [];
  let registered = true,
    waiting = false;
  const waiters = [];
  const { server, controller } = await createPortalServer({
    ...state,
    storageRoot: state.service.storageRoot,
    frontendUrl: 'https://studio.example.com',
    ownerEmail: owner.email,
    fetchImpl: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/user/self') {
        if (options.headers.cookie === 'auth=owner')
          return Response.json({
            id: owner.id,
            email: owner.email,
            role: owner.role,
          });
        if (options.headers.cookie === 'auth=creator')
          return Response.json({
            id: creator.id,
            email: creator.email,
            role: creator.role,
          });
        return new Response('', { status: 401 });
      }
      assert.equal(path, '/media/native-upload');
      assert.equal(options.headers.cookie, 'auth=owner');
      assert.equal(options.redirect, 'error');
      lookups.push(String(url));
      if (waiting) await new Promise((done) => waiters.push(done));
      return Response.json({
        registered:
          registered && new URL(url).searchParams.get('relative') === relative,
      });
    },
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise((done) => {
        for (const resume of waiters) resume();
        server.closeAllConnections();
        server.close(done);
      })
  );
  return {
    ...state,
    controller,
    base: `http://127.0.0.1:${server.address().port}`,
    lookups,
    setRegistered: (value) => {
      registered = value;
    },
    setWaiting: (value) => {
      waiting = value;
    },
    release: () => {
      waiting = false;
      for (const done of waiters.splice(0)) done();
    },
  };
}

test('real owner upload HTTP route serves GET, HEAD and ranges without public or creator access', async (t) => {
  const f = await httpSetup(t),
    url = `${f.base}/uploads/${relative}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { cookie: 'auth=creator' } })).status,
    403
  );
  assert.equal(f.lookups.length, 0);
  const request = (options = {}) =>
    fetch(url, {
      ...options,
      headers: { cookie: 'auth=owner', ...options.headers },
    });
  const full = await request();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Content-Type'), 'image/png');
  assert.equal(full.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), image);
  const head = await request({ method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(image.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await request({ headers: { Range: 'bytes=2-9' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 2-9/${image.length}`);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    image.subarray(2, 10)
  );
  for (const Range of ['bytes=-5', 'bytes=0-1,3-4', 'bytes=0-1000'])
    assert.equal((await request({ headers: { Range } })).status, 416);
  f.setRegistered(false);
  assert.equal((await request()).status, 404);
  assert.ok(
    f.lookups.every((url) =>
      url.startsWith('http://127.0.0.1:3000/media/native-upload?relative=')
    )
  );
});

test('pending native lookups are capped and an aborted request keeps its slot until completion', async (t) => {
  const f = await httpSetup(t);
  f.setWaiting(true);
  const abort = new AbortController();
  const requests = Array.from({ length: 8 }, (_, index) =>
    fetch(`${f.base}/uploads/${relative}`, {
      headers: { cookie: 'auth=owner' },
      ...(index === 0 ? { signal: abort.signal } : {}),
    }).catch(() => null)
  );
  const deadline = Date.now() + 3000;
  while (f.lookups.length < 8 && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(f.lookups.length, 8);
  abort.abort();
  const ninth = await fetch(`${f.base}/uploads/${relative}`, {
    headers: { cookie: 'auth=owner' },
  });
  assert.equal(ninth.status, 429);
  assert.equal(ninth.headers.get('Retry-After'), '5');
  f.release();
  await Promise.all(requests);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(f.controller.nativeStreams, 0);
});
