import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

export const endpoint = 'https://studio.ordersmp.net/creator/mcp';
export const unavailableMessage =
  'OrderSMP draft MCP is unavailable. Check the VPN and protected credential setup.';
const credentialFailure = () => new Error(unavailableMessage);
const allowed = new Set(['list_integrations', 'list_drafts', 'create_draft']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const emptySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};
const tools = [
  {
    name: 'list_integrations',
    description:
      'List official OrderSMP destinations and availability. This does not authorize publishing.',
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_drafts',
    description:
      "List this fixed submitter's private drafts and prepared clips.",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_draft',
    description:
      'Create an unapproved draft from a prepared clip. Owner review in Creator Studio is required before publication.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', format: 'uuid' },
        clipId: { type: 'string', format: 'uuid' },
        title: { type: 'string', maxLength: 180 },
        description: { type: 'string', maxLength: 5000 },
      },
      required: ['sourceId', 'clipId'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

// Provision with ConvertFrom-SecureString without a key. Its serialized text is
// Windows DPAPI CurrentUser data, not a raw Base64 ProtectedData blob.
export const decryptScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$secure = $null
try {
  $serialized = [System.IO.File]::ReadAllText($env:CREATOR_MCP_DPAPI_FILE).Trim()
  $secure = ConvertTo-SecureString -String $serialized
  $credential = [System.Management.Automation.PSCredential]::new('ordersmp-mcp', $secure)
  [Console]::Out.Write($credential.GetNetworkCredential().Password)
} catch {
  [Console]::Error.Write('Protected credential unavailable')
  exit 1
} finally {
  if ($null -ne $secure) { $secure.Dispose() }
}`;

export async function decryptWindowsCredential(
  filename,
  { environment = process.env, execFileImpl = execFile } = {}
) {
  try {
    if (
      typeof filename !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(filename) ||
      /[\r\n\0]/.test(filename)
    )
      throw credentialFailure();
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 20 ||
      info.size > 65536
    )
      throw credentialFailure();
    const childEnvironment = {};
    for (const name of [
      'SystemRoot',
      'SystemDrive',
      'TEMP',
      'TMP',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
    ])
      if (environment[name]) childEnvironment[name] = environment[name];
    childEnvironment.CREATOR_MCP_DPAPI_FILE = filename;
    childEnvironment.POWERSHELL_TELEMETRY_OPTOUT = '1';
    const executable = win32.join(
      environment.ProgramFiles || 'C:\\Program Files',
      'PowerShell',
      '7',
      'pwsh.exe'
    );
    return await new Promise((done, reject) => {
      execFileImpl(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(decryptScript, 'utf16le').toString('base64'),
        ],
        {
          encoding: 'utf8',
          maxBuffer: 16384,
          timeout: 10000,
          windowsHide: true,
          shell: false,
          env: childEnvironment,
        },
        (error, stdout) => (error ? reject(credentialFailure()) : done(stdout))
      );
    });
  } catch {
    throw credentialFailure();
  }
}

export async function loadCredential({
  environment = process.env,
  platform = process.platform,
  decryptor,
} = {}) {
  try {
    if (
      !environment.CREATOR_MCP_DPAPI_FILE ||
      (!decryptor && platform !== 'win32') ||
      environment.NODE_TLS_REJECT_UNAUTHORIZED === '0'
    )
      throw credentialFailure();
    const token = await (
      decryptor ||
      ((filename) => decryptWindowsCredential(filename, { environment }))
    )(environment.CREATOR_MCP_DPAPI_FILE);
    if (
      typeof token !== 'string' ||
      token.length < 32 ||
      token.length > 4096 ||
      !/^[\x21-\x7e]+$/.test(token)
    )
      throw credentialFailure();
    return token;
  } catch {
    throw credentialFailure();
  }
}

export function fixedEndpointFetch(token, fetchImpl = fetch, signal) {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint || !['GET', 'POST'].includes(init.method || 'GET'))
      throw credentialFailure();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.delete('Cookie');
    headers.delete('Proxy-Authorization');
    return fetchImpl(endpoint, {
      ...init,
      headers,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.any(
        [signal, init.signal, AbortSignal.timeout(15000)].filter(Boolean)
      ),
    });
  };
}

function validateArguments(name, value) {
  const args = value ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (name !== 'create_draft') return Object.keys(args).length === 0;
  return (
    Object.keys(args).every((key) =>
      ['sourceId', 'clipId', 'title', 'description'].includes(key)
    ) &&
    typeof args.sourceId === 'string' &&
    uuid.test(args.sourceId) &&
    typeof args.clipId === 'string' &&
    uuid.test(args.clipId) &&
    (args.title === undefined ||
      (typeof args.title === 'string' && args.title.length <= 180)) &&
    (args.description === undefined ||
      (typeof args.description === 'string' && args.description.length <= 5000))
  );
}

export async function startDesktopAdapter({
  environment = process.env,
  platform = process.platform,
  decryptor,
  fetchImpl,
  signal,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let remote, local;
  let lastWarning = 0;
  const warn = () => {
    if (Date.now() - lastWarning > 1000) {
      lastWarning = Date.now();
      stderr.write(`${unavailableMessage}\n`);
    }
  };
  const close = async () => {
    await Promise.allSettled([local?.close(), remote?.close()]);
  };
  try {
    const token = await loadCredential({ environment, platform, decryptor });
    remote = new Client(
      { name: 'ordersmp-desktop-drafts', version: '1.0.0' },
      { capabilities: {} }
    );
    remote.onerror = warn;
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: fixedEndpointFetch(token, fetchImpl, signal),
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    await remote.connect(transport, { timeout: 15000 });
    const available = new Set(
      (await remote.listTools({}, { timeout: 15000 })).tools.map(
        (tool) => tool.name
      )
    );
    if (signal?.aborted) throw credentialFailure();
    if ([...allowed].some((name) => !available.has(name)))
      throw credentialFailure();
    local = new Server(
      { name: 'ordersmp-desktop-drafts', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    local.onerror = warn;
    local.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: structuredClone(tools),
    }));
    local.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (!allowed.has(name))
        throw new McpError(
          ErrorCode.InvalidParams,
          'Only OrderSMP draft tools are available'
        );
      if (request.params.task || !validateArguments(name, args))
        throw new McpError(
          ErrorCode.InvalidParams,
          'Review the draft tool arguments'
        );
      try {
        const response = await remote.callTool(
          { name, arguments: args || {} },
          undefined,
          { timeout: 20000 }
        );
        const content = response.content
          ?.filter((item) => item.type === 'text')
          .map((item) => ({ type: 'text', text: item.text }));
        if (
          response.isError ||
          !content?.length ||
          JSON.stringify(content).length > 1024 * 1024 ||
          content.some((item) => item.text.includes(token))
        )
          throw credentialFailure();
        return { content };
      } catch {
        warn();
        return {
          isError: true,
          content: [{ type: 'text', text: unavailableMessage }],
        };
      }
    });
    await local.connect(new StdioServerTransport(stdin, stdout));
    return { close };
  } catch {
    await close();
    warn();
    throw credentialFailure();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let adapter;
  const cancellation = new AbortController();
  let closing = false;
  const stop = async (failed = false) => {
    if (closing) return;
    closing = true;
    cancellation.abort();
    if (failed) process.stderr.write(`${unavailableMessage}\n`);
    await adapter?.close();
    process.exitCode = failed ? 1 : 0;
  };
  process.once('uncaughtException', () => {
    void stop(true);
  });
  process.once('unhandledRejection', () => {
    void stop(true);
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  try {
    adapter = await startDesktopAdapter({ signal: cancellation.signal });
    process.stdin.once('end', () => {
      void stop();
    });
  } catch {
    process.exitCode = 1;
  }
}
