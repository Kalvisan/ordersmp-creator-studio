import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readSecret } from './protocol.mjs';

const result = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const safeDraft = ({ id, sourceId, title, description, status, version }) => ({
  id,
  sourceId,
  title,
  description,
  status,
  version,
});

export function createDraftMcpServer({
  publishingService,
  creatorId,
  creatorEmail,
}) {
  if (!creatorId || !creatorEmail)
    throw new Error('A private MCP submitter must be configured');
  // This identity is deliberately never an owner, even when its verified email
  // also belongs to the operator. MCP has no route to approval or scheduling.
  const actor = {
    id: creatorId,
    email: creatorEmail,
    role: 'DRAFT_ASSISTANT',
    owner: false,
  };
  const server = new McpServer({ name: 'ordersmp-drafts', version: '1.0.0' });
  server.registerTool(
    'list_integrations',
    {
      description:
        'List official publishing destinations and availability. This grants no publishing authority.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(await publishingService.listIntegrations())
  );
  server.registerTool(
    'list_drafts',
    {
      description:
        "List this submitter's drafts and prepared clips. Other creators' recordings remain private.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      result({
        drafts: publishingService
          .listDrafts(actor)
          .slice(0, 100)
          .map(safeDraft),
        preparedClips: publishingService.repository
          .list('sources', (source) => source.creatorId === creatorId)
          .slice(-100)
          .flatMap((source) =>
            (source.clips || []).slice(0, 10).map((clip) => ({
              sourceId: source.id,
              clipId: clip.id,
              title: source.title,
              start: clip.start,
              end: clip.end,
            }))
          ),
      })
  );
  server.registerTool(
    'create_draft',
    {
      description:
        "Create an unapproved draft from one of this submitter's prepared clips. The channel owner must review rights, content and destinations in the browser before any publication.",
      inputSchema: {
        sourceId: z.string().uuid(),
        clipId: z.string().uuid(),
        title: z.string().max(180).optional(),
        description: z.string().max(5000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        return result(safeDraft(publishingService.createDraft(actor, input)));
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error.status
                ? error.message
                : 'Draft creation is unavailable',
            },
          ],
        };
      }
    }
  );
  return server;
}

export function createMcpHandler(options) {
  return async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    if (!options.creatorId || !options.creatorEmail || !options.tokenFile) {
      send(503, { error: 'Finish owner setup before enabling draft MCP.' });
      return true;
    }
    try {
      const token = await readSecret(options.tokenFile);
      const actual = Buffer.from(String(request.headers.authorization || ''));
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        send(401, { error: 'MCP token required' });
        return true;
      }
      if (request.headers.origin) {
        send(403, { error: 'Use a configured MCP client' });
        return true;
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        send(405, { error: 'Only stateless MCP POST requests are supported' });
        return true;
      }
      if (
        !String(request.headers['content-type'] || '').startsWith(
          'application/json'
        )
      ) {
        send(415, { error: 'Send a JSON request' });
        return true;
      }
      let size = 0;
      const parts = [];
      for await (const part of request) {
        size += part.length;
        if (size > 65536) {
          send(413, { error: 'MCP request too large' });
          return true;
        }
        parts.push(part);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        send(400, { error: 'Invalid JSON' });
        return true;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        send(400, { error: 'Send one MCP request' });
        return true;
      }
      const server = createDraftMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent)
        send(503, {
          error:
            'Draft MCP is unavailable. Check its private submitter and token configuration.',
        });
    }
    return true;
  };
}
