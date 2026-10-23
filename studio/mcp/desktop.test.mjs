import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  decryptWindowsCredential,
  endpoint,
  fixedEndpointFetch,
  loadCredential,
  startDesktopAdapter,
  unavailableMessage,
} from './desktop.mjs';

const token = 'test-only-disposable-token-0123456789abcdef';
const environment = {
  CREATOR_MCP_DPAPI_FILE: 'C:/nonsecret/creator-token.dpapi',
};
const uuid = '00000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const calls = [],
    outbound = new PassThrough(),
    inbound = new PassThrough(),
    stderr = new PassThrough();
  let output = '',
    errors = '',
    mode = 'normal';
  outbound.on('data', (chunk) => {
    output += chunk;
  });
  stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end('Bearer private-token-must-not-be-logged');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const remote = new McpServer({ name: 'test-remote-drafts', version: '1' });
    for (const name of ['list_integrations', 'list_drafts', 'publish'])
      remote.registerTool(name, { inputSchema: {} }, async () => {
        calls.push({ name });
        if (mode === 'error')
          throw new Error(`Sensitive upstream failure ${token}`);
        return {
          content: [
            {
              type: 'text',
              text:
                mode === 'leak'
                  ? token
                  : JSON.stringify({ ok: true, tool: name }),
            },
          ],
          _meta: { private: token },
        };
      });
    remote.registerTool(
      'create_draft',
      {
        inputSchema: {
          sourceId: z.string(),
          clipId: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
        },
      },
      async (args) => {
        calls.push({ name: 'create_draft', args });
        return {
          content: [
            { type: 'text', text: JSON.stringify({ status: 'draft' }) },
          ],
        };
      }
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void remote.close().catch(() => {});
      void transport.close().catch(() => {});
    });
    await remote.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${http.address().port}/creator/mcp`;
  const seen = [];
  const adapter = await startDesktopAdapter({
    environment,
    platform: 'linux',
    decryptor: async () => token,
    stdin: inbound,
    stdout: outbound,
    stderr,
    fetchImpl: async (input, init) => {
      seen.push({
        input,
        redirect: init.redirect,
        authorization: init.headers.get('Authorization'),
        credentials: init.credentials,
      });
      assert.equal(String(input), endpoint);
      return fetch(url, init);
    },
  });
  // The same newline JSON-RPC transport works on both ends of this real stdio
  // stream pair. The upstream side uses the actual SDK HTTP transport.
  const client = new Client(
    { name: 'desktop-test-client', version: '1' },
    { capabilities: {} }
  );
  await client.connect(new StdioServerTransport(outbound, inbound));
  t.after(async () => {
    await client.close();
    await adapter.close();
    await new Promise((done) => http.close(done));
    outbound.destroy();
    inbound.destroy();
    stderr.destroy();
  });
  return {
    client,
    calls,
    seen,
    output: () => output,
    errors: () => errors,
    setMode: (value) => {
      mode = value;
    },
  };
}

test('actual SDK stdio-to-HTTP bridge advertises only the fixed three tools', async (t) => {
  const f = await fixture(t);
  const tools = await f.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'create_draft',
    'list_drafts',
    'list_integrations',
  ]);
  assert.equal(
    tools.tools.some((tool) => tool.name === 'publish'),
    false
  );
  for (const name of ['publish', 'approve', 'schedule', 'delete_post'])
    await assert.rejects(
      f.client.callTool({ name, arguments: {} }),
      /Only OrderSMP draft tools/
    );
  assert.equal(f.calls.length, 0);
});

test('bridge forwards valid draft calls without authority fields or secret metadata', async (t) => {
  const f = await fixture(t);
  const response = await f.client.callTool({
    name: 'create_draft',
    arguments: {
      sourceId: uuid,
      clipId: uuid,
      title: 'Minecraft clip',
      description: 'A draft caption',
    },
  });
  assert.equal(JSON.parse(response.content[0].text).status, 'draft');
  await f.client.callTool({ name: 'list_drafts', arguments: {} });
  assert.equal(f.calls.length, 2);
  assert.equal(f.output().includes(token), false);
  assert.equal(f.errors().includes(token), false);
  assert.ok(
    f.seen.every(
      (request) =>
        request.input === endpoint &&
        request.redirect === 'error' &&
        request.authorization === `Bearer ${token}` &&
        request.credentials === 'omit'
    )
  );
});

test('bridge rejects publishing arguments and invalid source IDs before forwarding', async (t) => {
  const f = await fixture(t);
  for (const args of [
    { sourceId: uuid, clipId: uuid, publish: true },
    { sourceId: '../another', clipId: uuid },
    { sourceId: uuid, clipId: uuid, description: 'x'.repeat(5001) },
  ])
    await assert.rejects(
      f.client.callTool({ name: 'create_draft', arguments: args }),
      /Review the draft tool arguments/
    );
  await assert.rejects(
    f.client.callTool({
      name: 'list_integrations',
      arguments: { token: 'anything' },
    }),
    /Review the draft tool arguments/
  );
  assert.equal(f.calls.length, 0);
});

test('upstream errors and accidental token echoes never reach protocol output or logs', async (t) => {
  const f = await fixture(t);
  for (const mode of ['error', 'leak']) {
    f.setMode(mode);
    const result = await f.client.callTool({
      name: 'list_drafts',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, unavailableMessage);
  }
  assert.equal(f.output().includes(token), false);
  assert.equal(f.errors().includes(token), false);
  assert.equal(f.errors().includes('Sensitive'), false);
});

test('credentials fail closed without config, on non-Windows, or with insecure TLS', async () => {
  await assert.rejects(
    loadCredential({ environment: {}, decryptor: async () => token }),
    (error) => error.message === unavailableMessage
  );
  await assert.rejects(
    loadCredential({ environment, platform: 'linux' }),
    (error) => error.message === unavailableMessage
  );
  await assert.rejects(
    loadCredential({
      environment: { ...environment, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      decryptor: async () => token,
    }),
    (error) => error.message === unavailableMessage
  );
  for (const invalid of [
    '',
    'short',
    `${token}\n`,
    ' '.repeat(32),
    'x'.repeat(4097),
  ])
    await assert.rejects(
      loadCredential({ environment, decryptor: async () => invalid }),
      (error) => error.message === unavailableMessage
    );
});

test('network failure produces only a generic startup diagnostic', async () => {
  let errors = '';
  const stderr = {
    write: (text) => {
      errors += text;
    },
  };
  await assert.rejects(
    startDesktopAdapter({
      environment,
      platform: 'linux',
      decryptor: async () => token,
      stderr,
      fetchImpl: async () => {
        throw new Error(`Authorization: Bearer ${token}`);
      },
    }),
    (error) => error.message === unavailableMessage
  );
  assert.equal(errors, `${unavailableMessage}\n`);
  assert.equal(errors.includes(token), false);
});

test('fixed transport refuses alternative URLs and redirects while stripping cookies', async () => {
  const calls = [];
  const fetch = fixedEndpointFetch(token, async (input, init) => {
    calls.push({ input, init });
    return new Response('', {
      status: 302,
      headers: { Location: 'https://other.invalid/' },
    });
  });
  for (const url of [
    'http://studio.ordersmp.net/creator/mcp',
    `${endpoint}?target=other`,
    'https://other.invalid/creator/mcp',
  ])
    await assert.rejects(fetch(url, { method: 'POST' }));
  await assert.rejects(fetch(endpoint, { method: 'DELETE' }));
  await fetch(endpoint, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      Cookie: 'auth=private',
      Authorization: 'Bearer attacker',
      'Proxy-Authorization': 'private',
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.has('Cookie'), false);
  assert.equal(calls[0].init.headers.has('Proxy-Authorization'), false);
});

test(
  'PowerShell DPAPI call keeps token out of arguments and environment',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ordersmp-dpapi-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, 'serialized.dpapi');
    await writeFile(filename, 'serialized-test-fixture'.repeat(3));
    let call;
    assert.equal(
      await decryptWindowsCredential(filename, {
        environment: { ...process.env, UNRELATED_SECRET: token },
        execFileImpl: (executable, args, options, callback) => {
          call = { executable, args, options };
          callback(null, token);
        },
      }),
      token
    );
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.CREATOR_MCP_DPAPI_FILE, filename);
    assert.equal(call.args.includes('-EncodedCommand'), true);
    assert.equal(JSON.stringify(call.args).includes(token), false);
    assert.equal(JSON.stringify(call.options.env).includes(token), false);
    assert.equal(
      Buffer.from(call.args.at(-1), 'base64')
        .toString('utf16le')
        .includes('ConvertTo-SecureString'),
      true
    );
  }
);

test(
  'actual Windows CurrentUser DPAPI serialized-text round trip',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'ordersmp-dpapi-roundtrip-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, 'credential.dpapi'),
      secret = randomBytes(32).toString('hex');
    const script =
      "$ErrorActionPreference='Stop'; $value=[Console]::In.ReadToEnd(); ConvertTo-SecureString -String $value -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:CREATOR_MCP_DPAPI_FILE -NoNewline";
    await new Promise((done, reject) => {
      const child = execFile(
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
          env: { ...process.env, CREATOR_MCP_DPAPI_FILE: filename },
          windowsHide: true,
          encoding: 'utf8',
          timeout: 10000,
        },
        (error) =>
          error
            ? reject(new Error('Test credential provisioning failed'))
            : done()
      );
      child.stdin.end(secret);
    });
    assert.equal(
      await loadCredential({
        environment: { ...process.env, CREATOR_MCP_DPAPI_FILE: filename },
      }),
      secret
    );
  }
);
