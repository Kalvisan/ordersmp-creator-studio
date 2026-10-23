import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalServer } from './server.mjs';
import { bindGoogleLogin } from './login.mjs';

async function startServer(t) {
  let identityCalls = 0;
  const { server } = await createPortalServer({
    service: { initialize: async () => {} },
    repository: {},
    frontendUrl: 'https://studio.ordersmp.net',
    ownerEmail: 'private-owner@example.com',
    fetchImpl: async () => {
      identityCalls++;
      return new Response('', { status: 401 });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    identityCalls: () => identityCalls,
  };
}

test('public login serves one Google action with local assets, strict CSP and no account information', async (t) => {
  const app = await startServer(t);
  const response = await fetch(
    `${app.base}/auth/login?email=attacker@example.com`
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /OrderSMP/);
  assert.match(body, /Creator Studio/);
  assert.match(body, /Google account approved by the owner/);
  assert.match(body, /Source code \(AGPL-3.0\)/);
  assert.match(body, /role="alert" hidden/);
  assert.equal((body.match(/<button\b/g) || []).length, 1);
  assert.doesNotMatch(
    body,
    /<form\b|<input\b|password|sign up|register|example\.com|20,000|Entrepreneurs/i
  );
  assert.doesNotMatch(body, /<style\b|<script(?![^>]*\bsrc=)/i);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /style-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /form-action 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  for (const [path, mime] of [
    ['/auth/login.css', 'text/css'],
    ['/auth/login.mjs', 'text/javascript'],
    ['/brand/google-sign-in.png', 'image/png'],
    ['/brand/logo.png', 'image/png'],
    ['/brand/order-pixel.ttf', 'font/ttf'],
  ]) {
    const asset = await fetch(app.base + path);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get('content-type').startsWith(mime));
    assert.ok((await asset.arrayBuffer()).byteLength > 100);
  }
  assert.equal(app.identityCalls(), 0);
});

test('login HEAD and method handling do not widen private routes or static paths', async (t) => {
  const app = await startServer(t);
  const head = await fetch(`${app.base}/auth/login`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 100);
  assert.equal(await head.text(), '');
  assert.equal(
    (await fetch(`${app.base}/auth/login`, { method: 'POST' })).status,
    405
  );
  for (const path of [
    '/auth/login.mjs/private',
    '/auth/unknown',
    '/brand/__proto__',
    '/creator/api/session',
    '/uploads/recording.mp4',
  ])
    assert.equal((await fetch(app.base + path)).status, 401);
  assert.equal((await fetch(`${app.base}/creator/internal/jobs`)).status, 401);
  assert.equal(
    (
      await fetch(`${app.base}/creator/api/session`, {
        headers: { cookie: 'auth=forged' },
      })
    ).status,
    401
  );
  assert.equal(app.identityCalls(), 1);
});

function elements() {
  let click;
  const attributes = new Map();
  const button = {
    disabled: true,
    addEventListener(name, callback) {
      assert.equal(name, 'click');
      click = callback;
    },
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
  };
  const error = { hidden: true, textContent: '' };
  return {
    button,
    error,
    attributes,
    click: () => click(),
    document: {
      getElementById: (id) => (id === 'google-sign-in' ? button : error),
    },
  };
}

test('Google button uses the existing same-origin start route and follows only the Google authorization URL', async () => {
  const ui = elements();
  const target =
    'https://accounts.google.com/o/oauth2/v2/auth?state=fixture&code_challenge=fixture';
  const calls = [],
    navigations = [];
  bindGoogleLogin(
    ui.document,
    async (path, options) => {
      calls.push({ path, options });
      return Response.json({ url: target });
    },
    (url) => navigations.push(url)
  );
  assert.equal(ui.button.disabled, false);
  await ui.click();
  await ui.click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/auth/google/start');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(navigations, [target]);
  assert.equal(ui.button.disabled, true);
  assert.equal(ui.attributes.get('aria-busy'), 'true');
  assert.equal(ui.error.hidden, true);
});

for (const destination of [
  'https://attacker.example/o/oauth2/v2/auth',
  'javascript:alert(1)',
  'https://accounts.google.com.attacker.example/o/oauth2/v2/auth',
  'https://user:secret@accounts.google.com/o/oauth2/v2/auth',
  'https://accounts.google.com/other',
  'https://accounts.google.com/o/oauth2/v2/auth#private',
]) {
  test(`Google button rejects an unexpected authorization destination: ${
    destination.split(':')[0]
  } fixture`, async () => {
    const ui = elements();
    bindGoogleLogin(
      ui.document,
      async () => Response.json({ url: destination }),
      () => assert.fail('Unexpected redirect')
    );
    await ui.click();
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.error.hidden, false);
    assert.equal(
      ui.error.textContent,
      'Sign-in could not start. Try again in a moment.'
    );
    assert.equal(ui.attributes.has('aria-busy'), false);
  });
}

test('failed start responses show a generic accessible error and allow a fresh retry', async () => {
  const ui = elements();
  let attempts = 0;
  bindGoogleLogin(
    ui.document,
    async () => {
      if (++attempts === 1)
        throw new Error('sensitive provider error secret-token');
      return new Response('private diagnostic', { status: 403 });
    },
    () => assert.fail('Failed starts must not navigate')
  );
  await ui.click();
  assert.equal(ui.error.hidden, false);
  assert.doesNotMatch(ui.error.textContent, /sensitive|secret|private/);
  assert.equal(ui.button.disabled, false);
  await ui.click();
  assert.equal(attempts, 2);
  assert.equal(
    ui.error.textContent,
    'Sign-in could not start. Try again in a moment.'
  );
});
