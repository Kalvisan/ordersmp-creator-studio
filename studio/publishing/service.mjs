import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  statfs,
  unlink,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashJson, mediaHash, readSecret, signApproval } from './protocol.mjs';
import { capabilities, platformFor, reviewedSettings } from './platforms.mjs';

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const hashPattern = /^[a-f0-9]{64}$/;
const fileStamp = (info) =>
  [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(
    ':'
  );
const contentSnapshot = (draft) => ({
  creatorId: draft.creatorId,
  sourceId: draft.sourceId,
  title: draft.title,
  description: draft.description,
  media: draft.media,
  permissionId: draft.permissionId,
});
const text = (value, max, label) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail(`Review the ${label}`);
  return value.trim();
};

async function digestFile(filename, expected) {
  const info = await lstat(filename);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== expected.size ||
    info.size > 2 * 1024 ** 3
  )
    fail('A reviewed video changed. Prepare and review it again.', 409);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256)
    fail('A reviewed video changed. Prepare and review it again.', 409);
  const after = await lstat(filename);
  if (fileStamp(after) !== fileStamp(info))
    fail('A reviewed video changed while reading it', 409);
  return after;
}

export class PublishingService {
  constructor(options) {
    Object.assign(this, options);
    this.fetchImpl = options.fetchImpl || fetch;
    this.now = options.now || Date.now;
    this.storageRoot = resolve(options.storageRoot);
    this.approvedMediaRoot = resolve(
      options.approvedMediaRoot || join(this.storageRoot, 'delivery')
    );
    this.ownerEmail = options.ownerEmail?.trim().toLowerCase();
    this.allowedDiscordChannels = Array.isArray(options.allowedDiscordChannels)
      ? options.allowedDiscordChannels
      : String(options.allowedDiscordChannels || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
    this.busy = false;
    this.freezes = 0;
    this.reservedBytes = 0;
    this.verifiedPublicMedia = new Map();
    this.publicVerifying = new Map();
    this.recovered = false;
    const backend = new URL(options.postizBaseUrl);
    if (
      backend.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', 'postiz'].includes(backend.hostname) ||
      backend.username ||
      backend.password ||
      backend.search ||
      backend.hash
    )
      throw new Error('Publishing must use the fixed private backend');
    this.postizBaseUrl = backend.origin;
    if (options.publicMediaBaseUrl) {
      const media = new URL(options.publicMediaBaseUrl);
      if (
        media.protocol !== 'https:' ||
        media.username ||
        media.password ||
        media.search ||
        media.hash
      )
        throw new Error('Approved media needs its own HTTPS URL');
      this.publicMediaBaseUrl = media.href.endsWith('/')
        ? media.href
        : `${media.href}/`;
    }
    if (!this.ownerEmail) throw new Error('The publishing owner is required');
  }
  owner(actor) {
    if (
      !actor?.owner ||
      actor.email?.trim().toLowerCase() !== this.ownerEmail ||
      !['ADMIN', 'SUPERADMIN'].includes(actor.role)
    )
      fail('Only the channel owner can approve publication', 403);
  }
  setupReady() {
    return !!(
      this.publisherOrgId?.trim() &&
      this.apiKeyFile &&
      this.publicMediaBaseUrl
    );
  }
  own(actor, draftId) {
    const draft = this.repository.read('drafts', draftId);
    if (!actor?.id || !draft || (!actor.owner && draft.creatorId !== actor.id))
      fail('Draft not found', 404);
    return draft;
  }
  listDrafts(actor) {
    return this.repository
      .list('drafts', (draft) => actor.owner || draft.creatorId === actor.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  calendar(actor) {
    const ids = new Set(this.listDrafts(actor).map((draft) => draft.id));
    return this.repository
      .list('deliveries', (delivery) => ids.has(delivery.draftId))
      .map(
        ({
          id,
          draftId,
          platform,
          accountId,
          dueAt,
          status,
          releaseUrl,
          note,
        }) => ({
          id,
          draftId,
          platform,
          accountId,
          dueAt,
          status,
          releaseUrl,
          note,
        })
      );
  }
  async api(path, init = {}, preparedKey) {
    if (!this.setupReady())
      fail(
        'The owner must finish connecting the official publishing workspace',
        503
      );
    let apiKey = preparedKey;
    if (!apiKey) {
      try {
        apiKey = await readSecret(this.apiKeyFile);
      } catch {
        fail(
          'The owner must finish connecting the official publishing workspace',
          503
        );
      }
    }
    const response = await this.fetchImpl(
      new URL(`/public/v1${path}`, this.postizBaseUrl),
      {
        ...init,
        headers: {
          Authorization: apiKey,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      }
    );
    return response;
  }
  async listIntegrations() {
    const identity = await this.api('/me');
    if (
      !identity.ok ||
      (await identity.json())?.organization?.id !== this.publisherOrgId
    )
      fail('The official channel connection needs owner attention', 503);
    const response = await this.api('/integrations');
    if (!response.ok) fail('The channel connections are unavailable', 503);
    const accounts = await response.json();
    if (!Array.isArray(accounts) || accounts.length > 100)
      fail('The channel connection response is invalid', 503);
    return accounts.map((account) => {
      const platform = platformFor(account.identifier);
      return {
        id: String(account.id),
        name: String(account.name || '').slice(0, 150),
        platform,
        disabled: !!account.disabled,
        ...capabilities(platform, this),
        ...(account.disabled
          ? { ready: false, reason: 'Reconnect this account before publishing' }
          : {}),
      };
    });
  }
  createDraft(actor, input) {
    const source = this.repository.read('sources', input.sourceId);
    if (
      !actor?.id ||
      !source ||
      (!actor.owner && source.creatorId !== actor.id)
    )
      fail('Recording not found', 404);
    const clip = source.clips?.find((item) => item.id === input.clipId);
    if (!clip) fail('Choose a prepared clip');
    return this.repository.put(
      'drafts',
      randomUUID(),
      {
        creatorId: source.creatorId,
        creatorEmail: source.creatorEmail,
        sourceId: source.id,
        title: text(input.title ?? source.title, 180, 'title'),
        description: text(
          input.description ?? clip.transcript ?? '',
          5000,
          'caption'
        ),
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
        createdAt: new Date(this.now()).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      },
      0
    );
  }
  updateDraft(actor, input) {
    const draft = this.own(actor, input.draftId);
    if (draft.status !== 'draft')
      fail('Cancel the scheduled publication before editing this draft', 409);
    return this.repository.put(
      'drafts',
      draft.id,
      {
        ...draft,
        title: text(input.title, 180, 'title'),
        description: text(input.description, 5000, 'caption'),
        updatedAt: new Date(this.now()).toISOString(),
      },
      input.version
    );
  }
  permission(draft, destinations) {
    const permission = this.repository.read('permissions', draft.permissionId);
    if (
      !permission ||
      permission.revokedAt ||
      permission.sourceId !== draft.sourceId ||
      permission.creatorId !== draft.creatorId ||
      permission.confirmedBy !== draft.creatorEmail ||
      permission.editing !== true ||
      typeof permission.monetization !== 'boolean' ||
      destinations.some(
        (item) => !permission.platforms?.includes(item.platform)
      )
    )
      fail('The creator must confirm permission for these destinations', 409);
    return permission;
  }
  async sourceMedia(media) {
    if (
      !media ||
      !hashPattern.test(media.sha256 || '') ||
      !Number.isSafeInteger(media.size) ||
      media.size <= 0 ||
      media.mime !== 'video/mp4' ||
      !/^renders\/[a-f0-9-]{36}\.mp4$/.test(media.path || '')
    )
      fail('Choose a prepared MP4 clip');
    const root = await realpath(this.storageRoot);
    const directory = join(this.storageRoot, 'renders');
    if ((await lstat(directory)).isSymbolicLink())
      fail('Invalid recording library');
    const filename = resolve(this.storageRoot, media.path);
    if (!(await realpath(filename)).startsWith(`${root}${sep}`))
      fail('Invalid recording library');
    await digestFile(filename, media);
    return filename;
  }
  async freezeMedia(media) {
    if (this.freezes >= 2)
      fail('Wait for the current video review to finish', 429);
    this.freezes++;
    try {
      return await this.freezeMediaFile(media);
    } finally {
      this.freezes--;
    }
  }
  async reserveMediaBytes(bytes) {
    this.reservedBytes += bytes;
    try {
      let used = 0,
        count = 0;
      for (const directory of new Set([
        join(this.storageRoot, 'inbox'),
        join(this.storageRoot, 'renders'),
        this.approvedMediaRoot,
      ])) {
        const files = await readdir(directory, { withFileTypes: true }).catch(
          (error) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          }
        );
        for (const file of files) {
          if (++count > 20000 || !file.isFile() || file.isSymbolicLink())
            fail('Ask the owner to check the recording library', 507);
          used += (await lstat(join(directory, file.name))).size;
        }
      }
      const jobs = this.repository
        .list('jobs', (job) => ['queued', 'processing'].includes(job.status))
        .reduce((sum, job) => sum + (job.reservedBytes || 0), 0);
      if (
        used + jobs + this.reservedBytes >
        (this.storageLimitBytes || 100 * 1024 ** 3)
      )
        fail(
          'The recording library is full. Ask the owner to free space.',
          507
        );
      const space = await statfs(this.storageRoot);
      if (space.bavail * space.bsize < this.reservedBytes + 5 * 1024 ** 3)
        fail('The server needs more free space before this review', 507);
    } catch (error) {
      this.reservedBytes -= bytes;
      throw error;
    }
  }
  async freezeMediaFile(media) {
    const source = await this.sourceMedia(media);
    await mkdir(this.approvedMediaRoot, { recursive: true, mode: 0o750 });
    if ((await lstat(this.approvedMediaRoot)).isSymbolicLink())
      fail('Invalid approved media library');
    const filename = join(this.approvedMediaRoot, `${media.sha256}.mp4`);
    try {
      await lstat(filename);
      await digestFile(filename, media);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.reserveMediaBytes(media.size);
      const temporary = join(this.approvedMediaRoot, `${randomUUID()}.partial`);
      const hash = createHash('sha256');
      let size = 0;
      try {
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            size += chunk.length;
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(
          createReadStream(source),
          meter,
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
        );
        if (size !== media.size || hash.digest('hex') !== media.sha256)
          fail('The prepared clip changed during review', 409);
        await chmod(temporary, 0o440);
        try {
          await link(temporary, filename);
        } catch (collision) {
          if (collision.code !== 'EEXIST') throw collision;
        }
        await digestFile(filename, media);
      } finally {
        this.reservedBytes -= media.size;
        await unlink(temporary).catch(() => {});
      }
    }
    this.verifiedPublicMedia.set(
      media.sha256,
      fileStamp(await digestFile(filename, media))
    );
    return { ...media, path: `${this.publicMediaBaseUrl}${media.sha256}.mp4` };
  }
  async approveAndSchedule(actor, draftId, input) {
    this.owner(actor);
    if (!this.setupReady())
      fail(
        'The owner must finish connecting the official publishing workspace',
        503
      );
    const draft = this.own(actor, draftId);
    if (
      input.rightsConfirmed !== true ||
      draft.status !== 'draft' ||
      draft.version !== input.version
    )
      fail(
        'Refresh the draft and confirm creator rights before approving',
        409
      );
    const due = Date.parse(input.dueAt);
    if (
      !Number.isFinite(due) ||
      due < this.now() - 1000 ||
      due > this.now() + 31 * 86400000
    )
      fail('Choose a publication time within the next 31 days');
    if (
      !Array.isArray(input.destinations) ||
      !input.destinations.length ||
      input.destinations.length > 4 ||
      new Set(input.destinations.map((item) => item.accountId)).size !==
        input.destinations.length
    )
      fail('Choose between one and four distinct accounts');
    const permission = this.permission(draft, input.destinations);
    const accounts = await this.listIntegrations();
    if (!Array.isArray(draft.media) || draft.media.length !== 1)
      fail('The first release publishes one prepared clip per post');
    const frozen = await Promise.all(
      draft.media.map((media) => this.freezeMedia(media))
    );
    const credit = text(permission.credit || '', 500, 'creator credit');
    const content = `${draft.description}${
      credit ? `\n\n${credit}` : ''
    }`.trim();
    const destinations = input.destinations.map((destination) => {
      const account = accounts.find(
        (item) =>
          item.id === destination.accountId &&
          item.platform === destination.platform
      );
      if (!account?.ready)
        fail(account?.reason || 'Choose a connected supported account');
      const settings = reviewedSettings(
        destination.platform,
        destination.settings,
        content,
        this
      );
      const body = {
        type: 'now',
        date: new Date(due).toISOString(),
        shortLink: false,
        tags: [],
        posts: [
          {
            integration: { id: account.id },
            settings,
            value: [
              {
                content,
                image: frozen.map((media) => ({
                  id: media.sha256,
                  path: media.path,
                  sha256: media.sha256,
                })),
              },
            ],
          },
        ],
      };
      return {
        platform: destination.platform,
        accountId: account.id,
        body,
        bodyHash: hashJson(body),
        mediaHash: mediaHash(body),
      };
    });
    const approvalId = randomUUID();
    const snapshot = {
      draft: contentSnapshot(draft),
      permission,
      destinations,
      dueAt: new Date(due).toISOString(),
      media: frozen,
    };
    return this.repository.transaction((state) => {
      if (
        state.drafts[draft.id]?.version !== draft.version ||
        state.drafts[draft.id]?.status !== 'draft' ||
        state.permissions[permission.id]?.version !== permission.version ||
        state.permissions[permission.id]?.revokedAt
      )
        fail(
          'This draft or permission changed during review. Refresh it.',
          409
        );
      state.approvals[approvalId] = {
        id: approvalId,
        version: 1,
        draftId: draft.id,
        reviewerEmail: actor.email.toLowerCase(),
        approvedAt: new Date(this.now()).toISOString(),
        snapshot,
        snapshotHash: hashJson(snapshot),
      };
      for (const destination of destinations) {
        const id = randomUUID();
        state.deliveries[id] = {
          id,
          version: 1,
          approvalId,
          draftId: draft.id,
          platform: destination.platform,
          accountId: destination.accountId,
          dueAt: snapshot.dueAt,
          status: 'scheduled',
          body: destination.body,
          bodyHash: destination.bodyHash,
          mediaHash: destination.mediaHash,
          createdAt: new Date(this.now()).toISOString(),
        };
      }
      state.drafts[draft.id] = {
        ...draft,
        version: draft.version + 1,
        status: 'scheduled',
        updatedAt: new Date(this.now()).toISOString(),
      };
      return {
        approvalId,
        draftId: draft.id,
        dueAt: snapshot.dueAt,
        status: 'scheduled',
        destinations: destinations.map(({ platform, accountId }) => ({
          platform,
          accountId,
        })),
      };
    });
  }
  cancel(actor, draftId) {
    this.owner(actor);
    const draft = this.own(actor, draftId);
    return this.repository.transaction((state) => {
      let needsReview = false;
      for (const delivery of Object.values(state.deliveries).filter(
        (item) => item.draftId === draft.id
      )) {
        if (delivery.status === 'scheduled') {
          delivery.status = 'cancelled';
          delivery.version++;
        } else if (
          ['dispatching', 'processing', 'uncertain'].includes(delivery.status)
        ) {
          delivery.cancelRequested = true;
          delivery.version++;
          needsReview = true;
        }
      }
      // Accepted provider requests need manual confirmation. Never claim that a
      // video already sent to a platform has been removed by cancelling a queue.
      state.drafts[draft.id] = {
        ...state.drafts[draft.id],
        status: needsReview ? 'cancel_review' : 'draft',
        version: state.drafts[draft.id].version + 1,
      };
      return {
        draftId,
        status: needsReview ? 'cancel_review' : 'draft',
        note: needsReview
          ? 'Check the platform and remove any accepted publication manually.'
          : 'Pending local deliveries cancelled. Existing public videos are unchanged.',
      };
    });
  }
  saveDelivery(id, update) {
    const delivery = this.repository.read('deliveries', id);
    return this.repository.put(
      'deliveries',
      id,
      { ...delivery, ...update, updatedAt: new Date(this.now()).toISOString() },
      delivery.version
    );
  }
  async validateDelivery(delivery) {
    const approval = this.repository.read('approvals', delivery.approvalId);
    const draft = this.repository.read('drafts', delivery.draftId);
    if (
      !approval ||
      !draft ||
      approval.reviewerEmail !== this.ownerEmail ||
      hashJson(approval.snapshot) !== approval.snapshotHash ||
      hashJson(contentSnapshot(draft)) !== hashJson(approval.snapshot.draft)
    )
      fail('The reviewed content changed', 409);
    const permission = this.permission(draft, [
      { platform: delivery.platform },
    ]);
    if (hashJson(permission) !== hashJson(approval.snapshot.permission))
      fail('Creator permission changed after review', 409);
    const reviewed = approval.snapshot.destinations.find(
      (item) =>
        item.platform === delivery.platform &&
        item.accountId === delivery.accountId
    );
    if (
      !reviewed ||
      delivery.dueAt !== approval.snapshot.dueAt ||
      hashJson(delivery.body) !== reviewed.bodyHash ||
      delivery.bodyHash !== reviewed.bodyHash ||
      mediaHash(delivery.body) !== reviewed.mediaHash ||
      delivery.mediaHash !== reviewed.mediaHash ||
      delivery.body.type !== 'now'
    )
      fail('Publication settings changed after review', 409);
    for (const media of approval.snapshot.media) {
      if (media.path !== `${this.publicMediaBaseUrl}${media.sha256}.mp4`)
        fail('Approved media URL changed', 409);
      const info = await digestFile(
        join(this.approvedMediaRoot, `${media.sha256}.mp4`),
        media
      );
      this.verifiedPublicMedia.set(media.sha256, fileStamp(info));
    }
    const accounts = await this.listIntegrations();
    if (
      !accounts.some(
        (account) =>
          account.id === delivery.accountId &&
          account.platform === delivery.platform &&
          account.ready
      )
    )
      fail('The destination needs owner attention', 409);
    return permission;
  }
  eligiblePublicMedia(sha256) {
    const now = this.now();
    for (const delivery of this.repository.list('deliveries', (item) =>
      ['dispatching', 'processing', 'published'].includes(item.status)
    )) {
      const due = Date.parse(delivery.dueAt);
      if (
        !Number.isFinite(due) ||
        due > now + 5 * 60000 ||
        due + 48 * 3600000 <= now
      )
        continue;
      const approval = this.repository.read('approvals', delivery.approvalId);
      const draft = this.repository.read('drafts', delivery.draftId);
      if (
        !approval ||
        !draft ||
        approval.reviewerEmail !== this.ownerEmail ||
        hashJson(approval.snapshot) !== approval.snapshotHash ||
        hashJson(contentSnapshot(draft)) !== hashJson(approval.snapshot.draft)
      )
        continue;
      const source = this.repository.read('sources', draft.sourceId);
      if (
        !source ||
        source.permissionId !== draft.permissionId ||
        source.creatorId !== draft.creatorId
      )
        continue;
      let permission;
      try {
        permission = this.permission(draft, [{ platform: delivery.platform }]);
      } catch {
        continue;
      }
      if (hashJson(permission) !== hashJson(approval.snapshot.permission))
        continue;
      const reviewed = approval.snapshot.destinations.find(
        (item) =>
          item.platform === delivery.platform &&
          item.accountId === delivery.accountId
      );
      if (
        !reviewed ||
        delivery.dueAt !== approval.snapshot.dueAt ||
        hashJson(delivery.body) !== reviewed.bodyHash ||
        delivery.bodyHash !== reviewed.bodyHash ||
        mediaHash(delivery.body) !== reviewed.mediaHash
      )
        continue;
      const media = approval.snapshot.media.find(
        (item) => item.sha256 === sha256
      );
      if (media?.path === `${this.publicMediaBaseUrl}${sha256}.mp4`)
        return media;
    }
    return null;
  }
  async resolvePublicMedia(basename) {
    const unavailable = () => fail('Video not found', 404);
    if (typeof basename !== 'string' || !/^[a-f0-9]{64}\.mp4$/.test(basename))
      unavailable();
    const sha256 = basename.slice(0, 64);
    try {
      const media = this.eligiblePublicMedia(sha256);
      if (!media) unavailable();
      const filename = join(this.approvedMediaRoot, basename);
      const info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== media.size)
        unavailable();
      // Approval and dispatch already hash the complete file. Reuse that result
      // for provider range requests only while inode, size and timestamps match.
      if (this.verifiedPublicMedia.get(sha256) !== fileStamp(info)) {
        let verifying = this.publicVerifying.get(sha256);
        if (!verifying) {
          if (this.publicVerifying.size >= 2) unavailable();
          verifying = digestFile(filename, media)
            .then((verified) => {
              if (this.verifiedPublicMedia.size >= 5000)
                this.verifiedPublicMedia.clear();
              this.verifiedPublicMedia.set(sha256, fileStamp(verified));
            })
            .finally(() => this.publicVerifying.delete(sha256));
          this.publicVerifying.set(sha256, verifying);
        }
        await verifying;
      }
      if (!this.eligiblePublicMedia(sha256)) unavailable();
      return { filename, size: media.size };
    } catch {
      unavailable();
    }
  }
  async reconcile(delivery) {
    if (!delivery.postIds?.length) return;
    const start = new Date(
      Date.parse(delivery.dispatchedAt) - 86400000
    ).toISOString();
    const end = new Date(this.now() + 86400000).toISOString();
    const response = await this.api(
      `/posts?startDate=${encodeURIComponent(
        start
      )}&endDate=${encodeURIComponent(end)}`
    );
    if (!response.ok) return;
    const result = await response.json();
    const posts = Array.isArray(result.posts)
      ? result.posts.filter((post) => delivery.postIds.includes(post.id))
      : [];
    if (posts.length !== delivery.postIds.length) return;
    if (posts.some((post) => post.state === 'ERROR'))
      this.saveDelivery(delivery.id, {
        status: 'failed_review',
        note: 'The platform rejected publication. Review it before trying again.',
      });
    else if (
      posts.every(
        (post) =>
          post.state === 'PUBLISHED' &&
          typeof post.releaseURL === 'string' &&
          /^https:\/\//.test(post.releaseURL)
      )
    )
      this.saveDelivery(delivery.id, {
        status: 'published',
        releaseUrl: posts[0].releaseURL,
        note: delivery.cancelRequested
          ? 'This video was accepted before cancellation. Remove it on the platform if required.'
          : null,
      });
    else if (this.now() - Date.parse(delivery.dispatchedAt) > 3600000)
      this.saveDelivery(delivery.id, {
        status: 'uncertain',
        note: 'Publication has not been confirmed. Check the platform before retrying.',
      });
  }
  async tick() {
    if (!this.setupReady()) return;
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.recovered) {
        for (const delivery of this.repository.list(
          'deliveries',
          (item) => item.status === 'dispatching'
        ))
          this.saveDelivery(delivery.id, {
            status: 'uncertain',
            note: 'The publisher restarted during dispatch. Check the platform before retrying.',
          });
        this.recovered = true;
      }
      for (const delivery of this.repository
        .list('deliveries', (item) => item.status === 'processing')
        .slice(0, 20))
        await this.reconcile(delivery).catch(() => {});
      const due = this.repository
        .list(
          'deliveries',
          (item) =>
            item.status === 'scheduled' && Date.parse(item.dueAt) <= this.now()
        )
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      // Bound each tick. A provider outage never triggers a catch-up burst.
      for (const candidate of due.slice(0, 4)) {
        if (this.now() - Date.parse(candidate.dueAt) > 15 * 60000) {
          this.saveDelivery(candidate.id, {
            status: 'missed_review',
            note: 'This publication time was missed. Review and schedule it again.',
          });
          continue;
        }
        let permission;
        try {
          permission = await this.validateDelivery(candidate);
        } catch {
          this.saveDelivery(candidate.id, {
            status: 'blocked',
            note: 'Content, permission, media or destination changed. Review this draft again.',
          });
          continue;
        }
        if (
          this.repository.read('deliveries', candidate.id)?.status !==
          'scheduled'
        )
          continue;
        const header = await signApproval({
          body: candidate.body,
          orgId: this.publisherOrgId,
          permissionId: permission.id,
          reviewerEmail: this.ownerEmail,
          secretFile: this.approvalSecretFile,
          now: this.now(),
        });
        const apiKey = await readSecret(this.apiKeyFile);
        // Persist before the first network write. Restart recovery is uncertain,
        // so neither a timeout nor a process crash can cause automatic reposts.
        const claimed = this.repository.transaction((state) => {
          const current = state.deliveries[candidate.id],
            approval = state.approvals[candidate.approvalId];
          if (current?.status !== 'scheduled') return false;
          if (
            !approval ||
            hashJson(state.permissions[permission.id]) !==
              hashJson(approval.snapshot.permission) ||
            hashJson(contentSnapshot(state.drafts[candidate.draftId])) !==
              hashJson(approval.snapshot.draft)
          ) {
            current.status = 'blocked';
            current.note =
              'Content or permission changed immediately before dispatch.';
            current.version++;
            return false;
          }
          current.status = 'dispatching';
          current.dispatchedAt = new Date(this.now()).toISOString();
          current.version++;
          return true;
        });
        if (!claimed) continue;
        try {
          const response = await this.api(
            '/posts',
            {
              method: 'POST',
              headers: { 'X-Creator-Publish-Approval': header },
              body: JSON.stringify(candidate.body),
            },
            apiKey
          );
          if (!response.ok) {
            this.saveDelivery(candidate.id, {
              status:
                response.status >= 400 && response.status < 500
                  ? 'failed_review'
                  : 'uncertain',
              note: 'Publication was not confirmed. Review the platform before trying again.',
            });
            continue;
          }
          const result = await response.json();
          if (
            !Array.isArray(result) ||
            result.length !== 1 ||
            typeof result[0]?.postId !== 'string'
          )
            throw new Error('Uncertain publication result');
          this.saveDelivery(candidate.id, {
            status: 'processing',
            postIds: result.map((item) => item.postId),
            note: 'Accepted by the publisher. Waiting for platform confirmation.',
          });
        } catch {
          this.saveDelivery(candidate.id, {
            status: 'uncertain',
            note: 'The publisher response was lost. Check the platform before trying again.',
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async handler(request, response, actor) {
    const route = new URL(request.url, 'http://localhost').pathname.replace(
      /^\/creator\/api\/publishing\//,
      ''
    );
    if (
      ![
        'integrations',
        'drafts',
        'update',
        'approve',
        'cancel',
        'calendar',
      ].includes(route)
    )
      return false;
    if (!actor?.id) fail('Sign in with Google to continue', 401);
    let result;
    if (request.method === 'GET' && route === 'integrations')
      result = await this.listIntegrations();
    else if (request.method === 'GET' && route === 'drafts')
      result = this.listDrafts(actor);
    else if (request.method === 'GET' && route === 'calendar')
      result = this.calendar(actor);
    else if (
      request.method === 'POST' &&
      ['drafts', 'update', 'approve', 'cancel'].includes(route)
    ) {
      if (
        !String(request.headers['content-type'] || '').startsWith(
          'application/json'
        )
      )
        fail('Send a JSON request', 415);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) fail('The request is too large', 413);
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        fail('Invalid JSON request');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input))
        fail('Invalid request');
      if (route === 'drafts') result = this.createDraft(actor, input);
      else if (route === 'update') result = this.updateDraft(actor, input);
      else if (route === 'approve')
        result = await this.approveAndSchedule(actor, input.draftId, input);
      else result = this.cancel(actor, input.draftId);
    } else fail('Method not allowed', 405);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(result));
    return true;
  }
}
export const createPublishingService = (options) =>
  new PublishingService(options);
