import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpHandler } from './mcp.mjs';

async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ordersmp-mcp-'));
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, 't'.repeat(48));
  const actorCalls = [];
  const publishingService = {
    listIntegrations: async () => [
      { id: 'official', platform: 'youtube', ready: true },
    ],
    listDrafts: (actor) => {
      actorCalls.push(actor);
      return [
        {
          id: 'own-draft',
          sourceId: 'own-source',
          title: 'Own clip',
          description: 'Caption',
          status: 'draft',
          version: 1,
          creatorEmail: 'private@example.com',
          media: [{ path: '/private/file' }],
        },
      ];
    },
    createDraft: (actor, input) => {
      actorCalls.push(actor);
      if (input.sourceId === '00000000-0000-4000-8000-000000000002')
        throw Object.assign(new Error('Recording not found'), { status: 404 });
      return {
        id: 'new-draft',
        sourceId: input.sourceId,
        title: input.title,
        description: input.description,
        status: 'draft',
        version: 1,
      };
    },
    repository: {
      list: (collection, predicate) =>
        [
          {
            id: 'own-source',
            creatorId: 'submitter',
            title: 'Own',
            clips: [{ id: 'own-clip', start: 1, end: 20 }],
          },
          {
            id: 'other-source',
            creatorId: 'other',
            title: 'Private',
            clips: [],
          },
        ].filter(predicate),
    },
  };
  const handler = createMcpHandler({
    publishingService,
    tokenFile,
    creatorId: 'submitter',
    creatorEmail: 'owner@example.com',
    ...config,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/creator/mcp`;
  const call = async (method, params = {}, extra = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${'t'.repeat(48)}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-03-26',
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { url, call, actorCalls };
}

test('actual stateless HTTP MCP exposes exactly three draft/read tools', async (t) => {
  const f = await fixture(t);
  const response = await f.call('tools/list');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.result.tools.map((tool) => tool.name).sort(), [
    'create_draft',
    'list_drafts',
    'list_integrations',
  ]);
  for (const name of [
    'approve',
    'publish',
    'schedule',
    'approveAndSchedule',
    'delete_post',
  ]) {
    const blocked = await f.call('tools/call', { name, arguments: {} });
    assert.ok(blocked.body.error || blocked.body.result?.isError);
  }
});

test('MCP requires its own token and rejects browser-origin calls', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call('tools/list', {}, { Authorization: 'Bearer wrong' })).status,
    401
  );
  assert.equal(
    (await f.call('tools/list', {}, { Authorization: '' })).status,
    401
  );
  assert.equal(
    (await f.call('tools/list', {}, { Origin: 'https://studio.example.com' }))
      .status,
    403
  );
  const get = await fetch(f.url, {
    headers: { Authorization: `Bearer ${'t'.repeat(48)}` },
  });
  assert.equal(get.status, 405);
});

test('MCP fixed submitter never receives owner authority or other creator fields', async (t) => {
  const f = await fixture(t);
  const response = await f.call('tools/call', {
    name: 'list_drafts',
    arguments: {},
  });
  const data = JSON.parse(response.body.result.content[0].text);
  assert.equal(data.preparedClips.length, 1);
  assert.equal(data.preparedClips[0].sourceId, 'own-source');
  assert.equal(JSON.stringify(data).includes('private@example.com'), false);
  assert.equal(JSON.stringify(data).includes('/private/file'), false);
  assert.equal(f.actorCalls[0].owner, false);
  assert.equal(f.actorCalls[0].role, 'DRAFT_ASSISTANT');
});

test('MCP can create a draft but cannot attach another creator source', async (t) => {
  const f = await fixture(t);
  const input = {
    sourceId: '00000000-0000-4000-8000-000000000001',
    clipId: '00000000-0000-4000-8000-000000000003',
    title: 'Clip',
    description: 'Caption',
  };
  const response = await f.call('tools/call', {
    name: 'create_draft',
    arguments: input,
  });
  assert.equal(
    JSON.parse(response.body.result.content[0].text).status,
    'draft'
  );
  assert.equal(f.actorCalls[0].owner, false);
  const denied = await f.call('tools/call', {
    name: 'create_draft',
    arguments: { ...input, sourceId: '00000000-0000-4000-8000-000000000002' },
  });
  assert.equal(denied.body.result.isError, true);
});

test('unconfigured submitter fails closed even with a valid token', async (t) => {
  const f = await fixture(t, { creatorId: undefined });
  assert.equal((await f.call('tools/list')).status, 503);
});
