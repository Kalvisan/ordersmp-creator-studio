import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const platforms = ['youtube', 'tiktok', 'instagram', 'discord'];
const uuid = /^[a-f0-9-]{36}$/;
export const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export class PortalService {
  constructor({
    repository,
    storageRoot,
    ownerEmail,
    maxUploadBytes = 20 * 1024 ** 3,
    storageLimitBytes = 100 * 1024 ** 3,
  }) {
    this.repository = repository;
    this.storageRoot = resolve(storageRoot);
    this.ownerEmail = ownerEmail?.trim().toLowerCase();
    this.maxUploadBytes = maxUploadBytes;
    this.storageLimitBytes = storageLimitBytes;
    this.uploads = new Set();
    this.reserved = 0;
    if (!this.ownerEmail) throw new Error('The portal owner is not configured');
  }
  own(actor, sourceId) {
    const source = this.repository.read('sources', sourceId);
    if (!source || (!actor.owner && source.creatorId !== actor.id))
      fail('Recording not found', 404);
    return source;
  }
  sources(actor) {
    return this.repository
      .list('sources', (item) => actor.owner || item.creatorId === actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async initialize() {
    for (const directory of ['inbox', 'renders', 'delivery'])
      await mkdir(join(this.storageRoot, directory), {
        recursive: true,
        mode: 0o2770,
      });
    for (const name of await readdir(join(this.storageRoot, 'inbox'))) {
      if (
        /^[a-f0-9-]{36}\.partial$/.test(name) &&
        !(await lstat(join(this.storageRoot, 'inbox', name))).isSymbolicLink()
      )
        await unlink(join(this.storageRoot, 'inbox', name));
    }
  }
  async mediaUsage() {
    let size = 0,
      count = 0;
    for (const directory of ['inbox', 'renders', 'delivery']) {
      for (const item of await readdir(join(this.storageRoot, directory), {
        withFileTypes: true,
      })) {
        if (++count > 20000 || !item.isFile() || item.isSymbolicLink())
          fail('Ask the owner to check the recording library', 507);
        size += (await stat(join(this.storageRoot, directory, item.name))).size;
      }
    }
    return size;
  }
  reservedJobs() {
    return this.repository
      .list('jobs', (item) => ['queued', 'processing'].includes(item.status))
      .reduce((sum, item) => sum + (item.reservedBytes || 0), 0);
  }
  async safePath(path, prefix) {
    if (
      typeof path !== 'string' ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '..' || part === '.') ||
      isAbsolute(path) ||
      !path.startsWith(`${prefix}/`)
    )
      fail('Invalid media path');
    const full = resolve(this.storageRoot, path);
    if (
      !full.startsWith(`${this.storageRoot}${sep}`) ||
      relative(this.storageRoot, full).split(sep).includes('..')
    )
      fail('Invalid media path');
    const canonical = await realpath(full);
    const canonicalRoot = await realpath(this.storageRoot);
    for (const part of path
      .split('/')
      .map((_, index, all) =>
        join(this.storageRoot, ...all.slice(0, index + 1))
      ))
      if ((await lstat(part)).isSymbolicLink()) fail('Invalid media path');
    if (
      !canonical.startsWith(`${canonicalRoot}${sep}`) ||
      !(await stat(full)).isFile()
    )
      fail('Invalid media path');
    return full;
  }
  async upload(actor, request, name) {
    if (this.uploads.size >= 2 || this.uploads.has(actor.id))
      fail('Wait for the current upload to finish', 429);
    const declared = Number(request.headers['content-length']);
    if (
      !Number.isSafeInteger(declared) ||
      declared <= 0 ||
      declared > this.maxUploadBytes
    )
      fail('Choose a video smaller than 20 GiB', 413);
    this.uploads.add(actor.id);
    this.reserved += declared;
    const id = randomUUID();
    const path = `inbox/${id}`;
    const temporary = join(this.storageRoot, `${path}.partial`);
    const hash = createHash('sha256');
    let size = 0,
      header = Buffer.alloc(0);
    const meter = new Transform({
      transform: (chunk, encoding, callback) => {
        size += chunk.length;
        if (size > declared || size > this.maxUploadBytes)
          return callback(
            Object.assign(new Error('Upload is too large'), { status: 413 })
          );
        hash.update(chunk);
        if (header.length < 16)
          header = Buffer.concat([
            header,
            chunk.subarray(0, 16 - header.length),
          ]);
        callback(null, chunk);
      },
    });
    try {
      const sourceBytes = await this.mediaUsage();
      if (
        sourceBytes + this.reserved + this.reservedJobs() >
        this.storageLimitBytes
      )
        fail(
          'The recording library is full. Ask the owner to free space.',
          507
        );
      const space = await statfs(this.storageRoot);
      if (space.bavail * space.bsize < declared + 5 * 1024 ** 3)
        fail('The server needs more free space before this upload', 507);
      await pipeline(
        request,
        meter,
        createWriteStream(temporary, { flags: 'wx', mode: 0o640 })
      );
      if (size !== declared) fail('The upload did not finish. Try again.');
      const mp4 = header.subarray(4, 8).toString() === 'ftyp';
      const matroska = header
        .subarray(0, 4)
        .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      if (!mp4 && !matroska) fail('Choose an MP4, MOV or MKV video');
      await rename(temporary, join(this.storageRoot, path));
      const source = this.repository.put(
        'sources',
        id,
        {
          creatorId: actor.id,
          creatorEmail: actor.email,
          title: String(name || 'Untitled recording')
            .replace(/[\x00-\x1f\x7f]/g, '')
            .slice(0, 180),
          path,
          sha256: hash.digest('hex'),
          size,
          mime: mp4 ? 'video/mp4' : 'video/x-matroska',
          createdAt: new Date().toISOString(),
          clips: [],
          status: 'uploaded',
          permissionId: null,
        },
        0
      );
      return source;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      await unlink(join(this.storageRoot, path)).catch(() => {});
      throw error;
    } finally {
      this.uploads.delete(actor.id);
      this.reserved -= declared;
    }
  }
  permission(actor, sourceId, input) {
    const source = this.own(actor, sourceId);
    if (source.creatorId !== actor.id)
      fail('The creator must confirm this permission', 403);
    if (
      input.confirmed !== true ||
      input.editing !== true ||
      !Array.isArray(input.platforms) ||
      !input.platforms.length ||
      input.platforms.some((item) => !platforms.includes(item))
    )
      fail('Confirm your permission and choose the platforms');
    if (
      typeof input.credit !== 'string' ||
      !input.credit.trim() ||
      input.credit.length > 500
    )
      fail('Add the creator credit');
    const id = source.permissionId || randomUUID();
    const previous = this.repository.read('permissions', id);
    const permission = this.repository.put(
      'permissions',
      id,
      {
        creatorId: actor.id,
        creatorEmail: actor.email,
        sourceId,
        platforms: [...new Set(input.platforms)],
        editing: true,
        monetization: input.monetization === true,
        credit: input.credit.trim(),
        confirmedBy: actor.email,
        confirmedAt: new Date().toISOString(),
        revokedAt: null,
      },
      previous?.version || 0
    );
    this.repository.transaction((state) => {
      state.sources[sourceId] = {
        ...state.sources[sourceId],
        permissionId: id,
        version: state.sources[sourceId].version + 1,
      };
      for (const draft of Object.values(state.drafts))
        if (draft.sourceId === sourceId && draft.status === 'draft') {
          draft.permissionId = id;
          draft.version += 1;
        }
    });
    return permission;
  }
  revokePermission(actor, sourceId) {
    const source = this.own(actor, sourceId);
    const permission = this.repository.read('permissions', source.permissionId);
    if (!permission) fail('No permission is recorded', 404);
    return this.repository.put(
      'permissions',
      permission.id,
      { ...permission, revokedAt: new Date().toISOString() },
      permission.version
    );
  }
  async prepare(actor, sourceId, input) {
    const source = this.own(actor, sourceId);
    if (
      !Array.isArray(input.markers) ||
      input.markers.length > 10 ||
      input.markers.some(
        (marker) =>
          !Number.isFinite(marker.start) ||
          !Number.isFinite(marker.end) ||
          marker.start < 0 ||
          marker.end <= marker.start ||
          marker.end > 43200 ||
          marker.end - marker.start > 60 ||
          marker.end - marker.start < 3
      )
    )
      fail('Add up to 10 clip ranges, each 3 to 60 seconds long');
    if (!['auto', 'en', 'lv'].includes(input.language || 'auto'))
      fail('Choose a supported recording language');
    const existing = this.repository.list(
      'jobs',
      (job) =>
        job.sourceId === sourceId &&
        ['queued', 'processing'].includes(job.status)
    );
    if (existing.length)
      fail('This recording already has a preparation job', 409);
    if (
      this.repository.list(
        'jobs',
        (job) =>
          job.creatorId === source.creatorId &&
          ['queued', 'processing'].includes(job.status)
      ).length >= 5
    )
      fail('Wait for your queued recordings to finish', 429);
    const reservedBytes =
      Math.max(1, input.markers.length || 3) * 2 * 1024 ** 3;
    if (
      (await this.mediaUsage()) +
        this.reserved +
        this.reservedJobs() +
        reservedBytes >
      this.storageLimitBytes
    )
      fail('Free space before preparing more clips', 507);
    const id = randomUUID();
    const job = {
      id,
      version: 1,
      sourceId,
      creatorId: source.creatorId,
      sourcePath: source.path.split('/').pop(),
      markers: input.markers.map(({ start, end }) => ({ start, end })),
      language: input.language || 'auto',
      status: 'queued',
      createdAt: new Date().toISOString(),
      clips: [],
      reservedBytes,
    };
    return this.repository.transaction((state) => {
      if (
        Object.values(state.jobs).some(
          (item) =>
            item.sourceId === sourceId &&
            ['queued', 'processing'].includes(item.status)
        )
      )
        fail('This recording already has a preparation job', 409);
      state.jobs[id] = job;
      return job;
    });
  }
  claimJob() {
    if (
      !this.repository.list(
        'jobs',
        (item) =>
          item.status === 'queued' ||
          (item.status === 'processing' &&
            Date.parse(item.leaseExpiresAt) <= Date.now())
      ).length
    )
      return null;
    return this.repository.transaction((state) => {
      for (const item of Object.values(state.jobs)) {
        if (
          item.status === 'processing' &&
          Date.parse(item.leaseExpiresAt) <= Date.now()
        ) {
          item.status = 'failed';
          item.error =
            'Preparation stopped before finishing. Prepare the recording again.';
          item.reservedBytes = 0;
          item.version += 1;
        }
      }
      const job = Object.values(state.jobs).find(
        (item) => item.status === 'queued'
      );
      if (!job) return null;
      job.status = 'processing';
      job.claimedAt = new Date().toISOString();
      job.leaseToken = randomUUID();
      job.leaseExpiresAt = new Date(Date.now() + 12 * 3600000).toISOString();
      job.version += 1;
      return job;
    });
  }
  async completeJob(input) {
    if (!uuid.test(input.id || '')) fail('Invalid preparation job');
    const job = this.repository.read('jobs', input.id);
    if (
      !job ||
      job.status !== 'processing' ||
      input.leaseToken !== job.leaseToken ||
      new Date(job.leaseExpiresAt).getTime() <= Date.now()
    )
      fail('Preparation job is not active', 409);
    if (input.error)
      return this.repository.put(
        'jobs',
        job.id,
        {
          ...job,
          status: 'failed',
          reservedBytes: 0,
          error: String(input.error).slice(0, 300),
        },
        job.version
      );
    if (
      !Array.isArray(input.clips) ||
      !input.clips.length ||
      input.clips.length > 10
    )
      fail('A job must return 1 to 10 clips');
    const clips = [];
    for (const clip of input.clips) {
      if (
        !Number.isFinite(clip.start) ||
        !Number.isFinite(clip.end) ||
        clip.start < 0 ||
        clip.end <= clip.start ||
        clip.end - clip.start > 60.1 ||
        clip.end - clip.start < 2.9 ||
        !Number.isFinite(clip.duration) ||
        clip.duration < 2.9 ||
        clip.duration > 61 ||
        !/^[a-f0-9]{64}$/.test(clip.sha256 || '') ||
        typeof clip.transcript !== 'string' ||
        clip.transcript.length > 20000 ||
        !/^[a-f0-9-]{36}\.mp4$/.test(clip.path || '')
      )
        fail('Invalid prepared clip');
      const full = await this.safePath(`renders/${clip.path}`, 'renders');
      const info = await stat(full);
      if (info.size <= 0 || info.size > 2 * 1024 ** 3)
        fail('Prepared clip is too large');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(full)) hash.update(chunk);
      if (hash.digest('hex') !== clip.sha256)
        fail('Prepared clip checksum does not match');
      clips.push({
        id: randomUUID(),
        path: `renders/${clip.path}`,
        sha256: clip.sha256,
        start: clip.start,
        end: clip.end,
        duration: clip.duration,
        transcript: clip.transcript,
        size: info.size,
        mime: 'video/mp4',
      });
    }
    return this.repository.transaction((state) => {
      if (state.jobs[job.id].version !== job.version)
        fail('The preparation job changed', 409);
      const source = state.sources[job.sourceId];
      if (source.clips.length + clips.length > 100)
        fail(
          'This recording has enough clips. Review the existing clips first.'
        );
      source.clips.push(...clips);
      source.status = 'ready';
      source.version += 1;
      const finished = {
        ...state.jobs[job.id],
        status: 'ready',
        reservedBytes: 0,
        clips,
        transcript: String(input.transcript || '').slice(0, 200000),
        version: job.version + 1,
      };
      state.jobs[job.id] = finished;
      for (const clip of clips) {
        const id = randomUUID();
        state.drafts[id] = {
          id,
          version: 1,
          creatorId: source.creatorId,
          creatorEmail: source.creatorEmail,
          sourceId: source.id,
          title: `${source.title} (${Math.floor(clip.start)}s)`,
          description: clip.transcript.slice(0, 4000),
          media: [
            {
              path: clip.path,
              sha256: clip.sha256,
              size: clip.size,
              mime: clip.mime,
            },
          ],
          permissionId: source.permissionId,
          status: 'draft',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return finished;
    });
  }
  jobs(actor, sourceId) {
    this.own(actor, sourceId);
    return this.repository.list('jobs', (item) => item.sourceId === sourceId);
  }
  async media(actor, sourceId, clipId) {
    const source = this.own(actor, sourceId);
    const file = clipId
      ? source.clips.find((item) => item.id === clipId)
      : source;
    if (!file) fail('Video not found', 404);
    const path = await this.safePath(file.path, clipId ? 'renders' : 'inbox');
    return { path, size: (await stat(path)).size, mime: file.mime };
  }
}

export async function authenticatePortal(
  request,
  { backendUrl, ownerEmail, fetchImpl = fetch }
) {
  const cookie = request.headers.cookie;
  if (!cookie || cookie.length > 16384)
    fail('Sign in with Google to continue', 401);
  const endpoint = new URL('/user/self', backendUrl);
  const response = await fetchImpl(endpoint, {
    headers: { cookie },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) fail('Sign in with Google to continue', 401);
  const user = await response.json();
  if (typeof user?.id !== 'string' || typeof user?.email !== 'string')
    fail('Sign in with Google to continue', 401);
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    owner:
      ['ADMIN', 'SUPERADMIN'].includes(user.role) &&
      user.email.trim().toLowerCase() === ownerEmail.trim().toLowerCase(),
  };
}

export async function workerAuthorized(request, filename) {
  if (!filename) return false;
  const token = (await readFile(filename, 'utf8')).trim();
  const supplied = request.headers.authorization;
  if (token.length < 32 || typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied),
    expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
