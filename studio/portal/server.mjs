import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PortalRepository } from './repository.mjs';
import {
  PortalService,
  authenticatePortal,
  fail,
  workerAuthorized,
} from './service.mjs';

export async function readJson(request, maxBytes = 1024 * 1024) {
  if (
    !String(request.headers['content-type'] || '').startsWith(
      'application/json'
    )
  )
    fail('Send a JSON request', 415);
  let total = 0;
  const parts = [];
  for await (const part of request) {
    total += part.length;
    if (total > maxBytes) fail('The request is too large', 413);
    parts.push(part);
  }
  try {
    const result = JSON.parse(Buffer.concat(parts).toString());
    if (!result || typeof result !== 'object' || Array.isArray(result))
      fail('Invalid request');
    return result;
  } catch {
    fail('Invalid JSON request');
  }
}
export function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}
function streamMedia(request, response, file) {
  const close = () => file.handle?.close().catch(() => {});
  if (response.destroyed) {
    close();
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(String(request.headers.range || ''));
  if (request.headers.range && !match) {
    close();
    fail('Invalid video range', 416);
  }
  const start = match ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : file.size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end >= file.size
  ) {
    close();
    fail('Invalid video range', 416);
  }
  response.writeHead(match ? 206 : 200, {
    'Content-Type': file.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(match ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
    'Content-Disposition': 'inline',
  });
  if (request.method === 'HEAD') {
    close();
    return response.end();
  }
  const stream = file.handle
    ? file.handle.createReadStream({ start, end, autoClose: true })
    : createReadStream(file.path, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  return stream.pipe(response);
}
export class PortalController {
  constructor({
    service,
    backendUrl = 'http://127.0.0.1:3000',
    frontendUrl,
    ownerEmail,
    workerTokenFile,
    publishing,
    fetchImpl,
  }) {
    this.service = service;
    this.backendUrl = backendUrl;
    this.origin = new URL(frontendUrl).origin;
    this.ownerEmail = ownerEmail;
    this.workerTokenFile = workerTokenFile;
    this.publishing = publishing;
    this.fetchImpl = fetchImpl;
    this.publicStreams = 0;
    this.nativeStreams = 0;
    const backend = new URL(backendUrl);
    if (backend.protocol !== 'http:' || backend.hostname !== '127.0.0.1')
      throw new Error('The portal backend must use private loopback HTTP');
  }
  async handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    );
    try {
      const url = new URL(request.url, this.origin);
      const loginFiles = {
        '/auth/login': ['login.html', 'text/html; charset=utf-8'],
        '/auth/login.css': ['login.css', 'text/css; charset=utf-8'],
        '/auth/login.mjs': ['login.mjs', 'text/javascript; charset=utf-8'],
      };
      if (Object.hasOwn(loginFiles, url.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method))
          fail('Method not allowed', 405);
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
        );
        const [file, type] = loginFiles[url.pathname];
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Length': content.length,
        });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (url.pathname === '/creator/health' && request.method === 'GET')
        return json(response, 200, { ok: true });
      if (url.pathname.startsWith('/creator-media/')) {
        const route = /^\/creator-media\/([a-f0-9]{64}\.mp4)$/.exec(
          url.pathname
        );
        if (
          !route ||
          !['GET', 'HEAD'].includes(request.method) ||
          !this.publishing?.resolvePublicMedia
        )
          fail('Page not found', 404);
        if (this.publicStreams >= 8) {
          response.setHeader('Retry-After', '5');
          fail('Media is busy. Try again shortly.', 429);
        }
        this.publicStreams++;
        let released = false;
        let resolving = true;
        const release = () => {
          if (!released && !resolving) {
            released = true;
            this.publicStreams--;
          }
        };
        response.once('finish', release);
        response.once('close', release);
        try {
          const file = await this.publishing.resolvePublicMedia(route[1]);
          resolving = false;
          if (response.destroyed) {
            await file.handle?.close();
            release();
            return;
          }
          return streamMedia(request, response, {
            path: file.filename,
            size: file.size,
            mime: 'video/mp4',
          });
        } catch (error) {
          resolving = false;
          release();
          throw error;
        }
      }
      const branding = {
        '/brand/logo.png': ['order-logo.png', 'image/png'],
        '/brand/order-pixel.ttf': ['order-pixel.ttf', 'font/ttf'],
        // Google's pre-approved PNG button preserves its logo, type and spacing.
        // https://developers.google.com/identity/branding-guidelines
        '/brand/google-sign-in.png': ['google-sign-in.png', 'image/png'],
      };
      if (
        ['GET', 'HEAD'].includes(request.method) &&
        Object.hasOwn(branding, url.pathname)
      ) {
        const [file, type] = branding[url.pathname];
        const content = await readFile(
          new URL(`../assets/${file}`, import.meta.url)
        );
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Length': content.length,
        });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (url.pathname === '/creator/internal/jobs') {
        if (!(await workerAuthorized(request, this.workerTokenFile)))
          fail('Worker authorization required', 401);
        if (request.method === 'GET')
          return json(response, 200, this.service.claimJob());
        if (request.method === 'POST')
          return json(
            response,
            200,
            await this.service.completeJob(await readJson(request))
          );
        fail('Method not allowed', 405);
      }
      if (url.pathname === '/creator/mcp') {
        if (this.publishing?.mcpHandler)
          return this.publishing.mcpHandler(request, response);
        return json(response, 503, {
          error: 'Draft MCP is not configured. Ask the owner to finish setup.',
        });
      }
      let actor;
      try {
        actor = await authenticatePortal(request, {
          backendUrl: this.backendUrl,
          ownerEmail: this.ownerEmail,
          fetchImpl: this.fetchImpl,
        });
      } catch (error) {
        if (
          error.status === 401 &&
          ['/creator', '/creator/', '/creator/agents'].includes(url.pathname)
        ) {
          response.writeHead(303, { Location: '/auth/login' });
          return response.end();
        }
        throw error;
      }
      const agentFiles = {
        '/creator/agents': ['agents.html', 'text/html; charset=utf-8'],
        '/creator/agents.css': ['agents.css', 'text/css; charset=utf-8'],
      };
      if (Object.hasOwn(agentFiles, url.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method))
          fail('Method not allowed', 405);
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
        );
        const [file, type] = agentFiles[url.pathname];
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, {
          'Content-Type': type,
          'Content-Length': content.length,
        });
        return response.end(request.method === 'HEAD' ? undefined : content);
      }
      if (
        !['GET', 'HEAD'].includes(request.method) &&
        request.headers.origin !== this.origin
      )
        fail('Open Creator Studio in its own tab and try again', 403);
      if (url.pathname.startsWith('/uploads/')) {
        this.service.assertNativeUploadOwner(actor);
        if (!['GET', 'HEAD'].includes(request.method))
          fail('Method not allowed', 405);
        if (this.nativeStreams >= 8) {
          response.setHeader('Retry-After', '5');
          fail('Media is busy. Try again shortly.', 429);
        }
        this.nativeStreams++;
        let resolving = true,
          released = false;
        const release = () => {
          if (!resolving && !released) {
            released = true;
            this.nativeStreams--;
          }
        };
        response.once('finish', release);
        response.once('close', release);
        try {
          const file = await this.service.nativeUpload(
            actor,
            url.pathname.slice('/uploads/'.length),
            async (relative) => {
              const lookup = new URL('/media/native-upload', this.backendUrl);
              lookup.searchParams.set('relative', relative);
              const result = await (this.fetchImpl || fetch)(lookup, {
                headers: { cookie: request.headers.cookie },
                redirect: 'error',
                signal: AbortSignal.timeout(8000),
              });
              if (result.status === 401 || result.status === 403)
                fail(
                  'Only the channel owner can read native uploads',
                  result.status
                );
              if (!result.ok)
                fail('Native media is temporarily unavailable', 503);
              return (await result.json())?.registered === true;
            }
          );
          resolving = false;
          if (response.destroyed) {
            await file.handle?.close();
            release();
            return;
          }
          return streamMedia(request, response, file);
        } catch (error) {
          resolving = false;
          release();
          throw error;
        }
      }
      if (
        request.method === 'GET' &&
        ['/creator', '/creator/'].includes(url.pathname)
      ) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(
          await readFile(new URL('./ui.html', import.meta.url))
        );
      }
      const assets = {
        '/creator/portal.js': ['ui.mjs', 'text/javascript; charset=utf-8'],
        '/creator/portal.css': ['ui.css', 'text/css; charset=utf-8'],
      };
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        response.writeHead(200, { 'Content-Type': type });
        return response.end(await readFile(new URL(file, import.meta.url)));
      }
      if (request.method === 'GET' && url.pathname === '/creator/api/session')
        return json(response, 200, actor);
      if (request.method === 'GET' && url.pathname === '/creator/api/sources')
        return json(response, 200, this.service.sources(actor));
      if (request.method === 'POST' && url.pathname === '/creator/api/sources')
        return json(
          response,
          201,
          await this.service.upload(
            actor,
            request,
            url.searchParams.get('name')
          )
        );
      const route =
        /^\/creator\/api\/sources\/([a-f0-9-]{36})(?:\/(permission|revoke|prepare|jobs|media))?$/.exec(
          url.pathname
        );
      if (route) {
        const [, id, action] = route;
        if (request.method === 'GET' && !action)
          return json(response, 200, this.service.own(actor, id));
        if (request.method === 'GET' && action === 'permission') {
          const source = this.service.own(actor, id);
          return json(
            response,
            200,
            this.service.repository.read('permissions', source.permissionId)
          );
        }
        if (request.method === 'GET' && action === 'jobs') {
          const jobs = this.service
            .jobs(actor, id)
            .map(({ leaseToken, sourcePath, ...job }) => job);
          return json(response, 200, jobs);
        }
        if (request.method === 'POST' && action === 'permission')
          return json(
            response,
            200,
            this.service.permission(actor, id, await readJson(request))
          );
        if (request.method === 'POST' && action === 'revoke')
          return json(response, 200, this.service.revokePermission(actor, id));
        if (request.method === 'POST' && action === 'prepare')
          return json(
            response,
            201,
            await this.service.prepare(actor, id, await readJson(request))
          );
        if (request.method === 'GET' && action === 'media') {
          const file = await this.service.media(
            actor,
            id,
            url.searchParams.get('clip')
          );
          return streamMedia(request, response, file);
        }
      }
      if (
        url.pathname.startsWith('/creator/api/publishing/') &&
        this.publishing &&
        (await this.publishing.handler(request, response, actor))
      )
        return;
      fail('Page not found', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      json(response, Number.isInteger(error.status) ? error.status : 503, {
        error: error.status
          ? error.message
          : 'Creator Studio is temporarily unavailable. Try again shortly.',
      });
    }
  }
}

export async function createPortalServer(config) {
  const repository =
    config.repository || new PortalRepository(config.registryFile);
  const service =
    config.service || new PortalService({ ...config, repository });
  await service.initialize();
  const controller = new PortalController({ ...config, service });
  const server = createServer((request, response) =>
    controller.handle(request, response)
  );
  server.requestTimeout = 6 * 3600000;
  server.headersTimeout = 30000;
  server.maxRequestsPerSocket = 100;
  return { server, repository, service, controller };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.env.GOOGLE_ONLY_AUTH !== 'true')
    throw new Error('The portal requires Google-only authentication');
  const storageRoot =
    process.env.CREATOR_MEDIA_ROOT || '/var/lib/ordersmp-creator/media';
  const repository = new PortalRepository(
    process.env.CREATOR_REGISTRY_FILE || '/var/lib/ordersmp-creator/portal.json'
  );
  const { createPublishingService } = await import('../publishing/service.mjs');
  const publishing = createPublishingService({
    repository,
    storageRoot,
    approvedMediaRoot: `${storageRoot}/delivery`,
    publicMediaBaseUrl: process.env.CREATOR_PUBLIC_MEDIA_URL,
    postizBaseUrl: 'http://127.0.0.1:3000',
    publisherOrgId: process.env.CREATOR_PUBLISHER_ORG_ID,
    ownerEmail: process.env.GOOGLE_AUTH_OWNER_EMAIL,
    apiKeyFile: process.env.CREATOR_PUBLISHER_API_KEY_FILE,
    approvalSecretFile: process.env.CREATOR_PUBLISH_APPROVAL_SECRET_FILE,
    mcpTokenFile: process.env.CREATOR_MCP_TOKEN_FILE,
    allowedDiscordChannels: process.env.CREATOR_DISCORD_CHANNEL_IDS,
    allowedDiscordGuilds: process.env.CREATOR_DISCORD_GUILD_IDS,
    discordWebhookUrl: process.env.CREATOR_DISCORD_WEBHOOK_URL,
  });
  const { createMcpHandler } = await import('../publishing/mcp.mjs');
  if (
    process.env.CREATOR_MCP_TOKEN_FILE &&
    process.env.CREATOR_MCP_CREATOR_ID &&
    process.env.CREATOR_MCP_CREATOR_EMAIL
  ) {
    publishing.mcpHandler = createMcpHandler({
      publishingService: publishing,
      tokenFile: process.env.CREATOR_MCP_TOKEN_FILE,
      creatorId: process.env.CREATOR_MCP_CREATOR_ID,
      creatorEmail: process.env.CREATOR_MCP_CREATOR_EMAIL,
    });
  }
  const { server } = await createPortalServer({
    repository,
    storageRoot,
    publishing,
    postizUploadRoot: process.env.CREATOR_POSTIZ_UPLOAD_ROOT,
    backendUrl: 'http://127.0.0.1:3000',
    frontendUrl: process.env.FRONTEND_URL,
    ownerEmail: process.env.GOOGLE_AUTH_OWNER_EMAIL,
    workerTokenFile: process.env.CREATOR_WORKER_TOKEN_FILE,
  });
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await publishing.tick();
    } catch {
      /* Each delivery records its own failure. */
    } finally {
      ticking = false;
    }
  }, 10000);
  timer.unref();
  server.listen(16080, '127.0.0.1');
}
