import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordWebhookPublisher } from './discord.webhook.mjs';

const webhookId = '123456789012345670',
  guildId = '123456789012345671',
  channelId = '123456789012345678';
const url = `https://discord.com/api/webhooks/${webhookId}/${'x'.repeat(64)}`;
const config = { url, guilds: [guildId], channels: [channelId] };
test('webhook accepts only canonical Discord capability URLs and finite ID scopes', () => {
  assert.doesNotThrow(
    () =>
      new DiscordWebhookPublisher({
        ...config,
        url: url.replace('x'.repeat(64), 'a.b_-'.repeat(13)),
      })
  );
  for (const invalid of [
    url.replace('https:', 'http:'),
    url.replace('discord.com', 'discord.com.evil.test'),
    url.replace('discord.com', 'discordapp.com'),
    url + '?wait=true',
    url + '#x',
    url + '/',
    url.replace('discord.com', 'user@discord.com'),
    url.replace('/api/', '/api/v10/'),
    url + '\n',
  ])
    assert.throws(
      () => new DiscordWebhookPublisher({ ...config, url: invalid }),
      /canonical Discord/
    );
  for (const changed of [
    { guilds: [] },
    { channels: '*' },
    { guilds: ['not-a-snowflake'] },
    { guilds: Array(21).fill(guildId) },
  ])
    assert.throws(
      () => new DiscordWebhookPublisher({ ...config, ...changed }),
      /Whitelist/
    );
  assert.equal(
    JSON.stringify(new DiscordWebhookPublisher(config)).includes(
      'x'.repeat(64)
    ),
    false
  );
});

test('webhook identity checks guild, channel, type and ID without exposing metadata or credential errors', async () => {
  for (const changed of [
    { guild_id: '999999999999999999' },
    { channel_id: '999999999999999999' },
    { type: 2 },
    { id: '999999999999999999' },
  ]) {
    const publisher = new DiscordWebhookPublisher({
      ...config,
      fetchImpl: async (requested, init) => {
        assert.equal(String(requested), url);
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        return Response.json({
          id: webhookId,
          type: 1,
          guild_id: guildId,
          channel_id: channelId,
          ...changed,
        });
      },
    });
    const account = await publisher.integration();
    assert.equal(account.ready, false);
    assert.equal(JSON.stringify(account).includes(url), false);
    assert.equal(account.target, undefined);
  }
  const publisher = new DiscordWebhookPublisher({
    ...config,
    fetchImpl: async () => {
      throw new Error(`secret ${url}`);
    },
  });
  await assert.rejects(
    publisher.metadata(),
    (error) => !error.message.includes('x'.repeat(64)) && error.status === 503
  );
});
