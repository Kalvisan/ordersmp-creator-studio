import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalServer } from './server.mjs';

async function startServer(t) {
  const identities = [];
  const { server } = await createPortalServer({
    service: { initialize: async () => {} },
    repository: {},
    frontendUrl: 'https://studio.ordersmp.net',
    ownerEmail: 'private-owner@example.com',
    fetchImpl: async (url, options) => {
      identities.push({ url: String(url), cookie: options.headers.cookie });
      if (options.headers.cookie === 'auth=owner')
        return Response.json({
          id: 'owner-id',
          email: 'private-owner@example.com',
          role: 'SUPERADMIN',
        });
      if (options.headers.cookie === 'auth=creator')
        return Response.json({
          id: 'creator-id',
          email: 'private-creator@example.com',
          role: 'USER',
        });
      return new Response('', { status: 403 });
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
  return { base: `http://127.0.0.1:${server.address().port}`, identities };
}

test('the authenticated Agents page explains its unavailable state without invoking AI tools', async (t) => {
  const { base, identities } = await startServer(t);
  for (const cookie of ['auth=owner', 'auth=creator']) {
    const response = await fetch(
      `${base}/creator/agents?prompt=private-query`,
      { headers: { cookie } }
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.match(body, /AI agents are not enabled/);
    assert.match(body, /AI chat is not configured for this workspace/);
    assert.match(body, /the channel owner reviews publishing/);
    assert.match(body, /href="\/creator\/"[^>]*>Open Creator Studio<\/a>/);
    assert.doesNotMatch(
      body,
      /<form\b|<input\b|<textarea\b|<script\b|private-query|example\.com|copilot|api.key|token/i
    );
    assert.match(
      response.headers.get('content-security-policy'),
      /script-src 'none'/
    );
    assert.match(
      response.headers.get('content-security-policy'),
      /connect-src 'none'/
    );
  }
  assert.equal(identities.length, 2);
  assert.ok(
    identities.every(({ url }) => url === 'http://127.0.0.1:3000/user/self')
  );
});

test('Agents access is rechecked for each request and anonymous or rejected sessions receive only sign-in', async (t) => {
  const { base, identities } = await startServer(t);
  for (const method of ['GET', 'HEAD']) {
    for (const cookie of [undefined, 'auth=unallowlisted', 'auth=forged']) {
      const response = await fetch(
        `${base}/creator/agents?next=https://unexpected.invalid/`,
        {
          method,
          headers: cookie ? { cookie } : {},
          redirect: 'manual',
        }
      );
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/auth/login');
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(identities.length, 4);
  assert.equal((await fetch(`${base}/creator/agents.css`)).status, 401);
  for (const path of [
    '/creator/agents/private',
    '/creator/agents.css/private',
  ]) {
    const response = await fetch(base + path, {
      headers: { cookie: 'auth=owner' },
    });
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /AI agents are not enabled/);
  }
});

test('Agents HEAD, RSC navigation and methods preserve the authenticated static-page boundary', async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(`${base}/creator/agents`, {
    headers: { cookie: 'auth=owner', RSC: '1', 'Next-Router-Prefetch': '1' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /AI agents are not enabled/);
  const head = await fetch(`${base}/creator/agents`, {
    method: 'HEAD',
    headers: { cookie: 'auth=creator' },
  });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 100);
  assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const blocked = await fetch(`${base}/creator/agents`, {
      method,
      headers: { cookie: 'auth=owner' },
    });
    assert.equal(blocked.status, 405);
    assert.doesNotMatch(await blocked.text(), /AI agents are not enabled/);
  }
  const style = await fetch(`${base}/creator/agents.css`, {
    headers: { cookie: 'auth=creator' },
  });
  assert.equal(style.status, 200);
  assert.match(style.headers.get('content-type'), /^text\/css/);
  assert.match(await style.text(), /\.capability-action/);
  const styleHead = await fetch(`${base}/creator/agents.css`, {
    method: 'HEAD',
    headers: { cookie: 'auth=creator' },
  });
  assert.equal(styleHead.status, 200);
  assert.equal(await styleHead.text(), '');
  assert.equal(
    (
      await fetch(`${base}/creator/agents.css`, {
        method: 'POST',
        headers: { cookie: 'auth=owner' },
      })
    ).status,
    405
  );
});
