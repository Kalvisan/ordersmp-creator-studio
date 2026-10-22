import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { hashJson } from './protocol.mjs';

const snowflake = (value) =>
  typeof value === 'string' && /^\d{17,20}$/.test(value);
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};
const ids = (value) => {
  const values = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
  if (
    !values.length ||
    values.length > 20 ||
    values.some((item) => !snowflake(item))
  )
    fail(
      'Whitelist the Discord server and announcement channel before publishing',
      503
    );
  return new Set(values);
};
export const discordClipLimit = 10 * 1024 ** 2;

// The capability URL stays private and is never a persisted integration field.
export class DiscordWebhookPublisher {
  #url;
  #fetch;
  #guilds;
  #channels;
  constructor({ url, guilds, channels, fetchImpl = fetch }) {
    if (
      typeof url !== 'string' ||
      !/^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]{40,200}$/.test(
        url
      )
    )
      fail('Configure a canonical Discord incoming webhook URL', 503);
    this.#url = new URL(url);
    this.#fetch = fetchImpl;
    this.#guilds = ids(guilds);
    this.#channels = ids(channels);
    this.id = `discord-webhook:${this.#url.pathname.split('/')[3]}`;
  }
  async metadata() {
    try {
      const response = await this.#fetch(this.#url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (
        value?.type !== 1 ||
        `discord-webhook:${value.id}` !== this.id ||
        !this.#guilds.has(value.guild_id) ||
        !this.#channels.has(value.channel_id)
      )
        throw new Error();
      return {
        webhookId: value.id,
        guildId: value.guild_id,
        channelId: value.channel_id,
      };
    } catch {
      fail(
        'Check the Discord webhook and its approved server and channel',
        503
      );
    }
  }
  async integration() {
    try {
      return {
        id: this.id,
        name: 'OrderSMP Notices',
        platform: 'discord',
        disabled: false,
        ready: true,
        manualRequired: false,
        reason: null,
        target: await this.metadata(),
      };
    } catch {
      return {
        id: this.id,
        name: 'OrderSMP Notices',
        platform: 'discord',
        disabled: false,
        ready: false,
        manualRequired: true,
        reason: 'Check the Discord webhook and its approved server and channel',
      };
    }
  }
  validateReview({ body, media, target }) {
    if (
      !target ||
      target.webhookId !== this.id.slice('discord-webhook:'.length) ||
      !this.#guilds.has(target.guildId) ||
      !this.#channels.has(target.channelId) ||
      body?.posts?.length !== 1 ||
      body.posts[0].integration?.id !== this.id ||
      body.posts[0].settings?.channel !== target.channelId ||
      body.posts[0].value?.length !== 1 ||
      media?.length !== 1
    )
      fail('Review the exact Discord announcement channel');
    const content = body.posts[0].value[0].content;
    if (
      typeof content !== 'string' ||
      content.length > 2000 ||
      /@everyone|@here|<@(?:!|&)?\d+>/.test(content)
    )
      fail('Review the Discord caption and remove mentions');
    const clip = media[0];
    if (
      !Number.isSafeInteger(clip.size) ||
      clip.size <= 0 ||
      clip.size > discordClipLimit
    )
      fail(
        'Discord clips must be at most 10 MiB. Prepare a smaller clip or post it manually.'
      );
    if (
      !/^[a-f0-9]{64}$/.test(clip.sha256 || '') ||
      clip.mime !== 'video/mp4' ||
      hashJson(body.posts[0].value[0].image) !==
        hashJson([{ id: clip.sha256, path: clip.path, sha256: clip.sha256 }])
    )
      fail('Review the exact Discord video attachment');
  }
  async prepare({ body, media, target, approvedMediaRoot }) {
    this.validateReview({ body, media, target });
    if (hashJson(await this.metadata()) !== hashJson(target))
      fail(
        'The Discord webhook moved after review. Review the destination again.'
      );
    const clip = media[0],
      filename = join(approvedMediaRoot, `${clip.sha256}.mp4`);
    let handle;
    try {
      const root = await realpath(approvedMediaRoot);
      handle = await open(
        filename,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
      );
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size !== clip.size ||
        info.size > discordClipLimit ||
        (await realpath(filename)) !== join(root, `${clip.sha256}.mp4`) ||
        (process.platform === 'linux' &&
          (await realpath(`/proc/self/fd/${handle.fd}`)) !==
            join(root, `${clip.sha256}.mp4`))
      )
        throw new Error();
      // A bounded snapshot is hashed and sent as the same bytes, without reopening.
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset
        );
        if (!bytesRead) throw new Error();
        offset += bytesRead;
      }
      if (
        (await handle.stat()).size !== info.size ||
        createHash('sha256').update(bytes).digest('hex') !== clip.sha256
      )
        throw new Error();
      const form = new FormData();
      form.set(
        'payload_json',
        JSON.stringify({
          content: body.posts[0].value[0].content,
          username: 'OrderSMP Notices',
          allowed_mentions: { parse: [] },
          attachments: [{ id: 0, filename: `${clip.sha256}.mp4` }],
        })
      );
      // No avatar override: use the webhook's uploaded OrderSMP avatar.
      form.set(
        'files[0]',
        new Blob([bytes], { type: 'video/mp4' }),
        `${clip.sha256}.mp4`
      );
      return { form, target };
    } catch {
      fail('The reviewed Discord clip changed. Prepare and review it again.');
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  async publish({ form, target }) {
    // No retry here. A lost response can mean that Discord accepted the message.
    const url = new URL(this.#url);
    url.searchParams.set('wait', 'true');
    const response = await this.#fetch(url, {
      method: 'POST',
      body: form,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      return {
        status:
          response.status >= 400 && response.status < 500
            ? 'failed_review'
            : 'uncertain',
        note: 'Discord did not confirm publication. Check the channel before trying again.',
      };
    const message = await response.json();
    if (
      !snowflake(message?.id) ||
      message.channel_id !== target.channelId ||
      message.webhook_id !== target.webhookId
    )
      throw new Error('Uncertain Discord publication result');
    return {
      status: 'published',
      messageId: message.id,
      releaseUrl: `https://discord.com/channels/${target.guildId}/${target.channelId}/${message.id}`,
      note: null,
    };
  }
}
