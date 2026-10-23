const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
const onlyKeys = (settings, keys) => {
  if (
    !settings ||
    typeof settings !== 'object' ||
    Array.isArray(settings) ||
    Object.keys(settings).some((key) => !keys.includes(key))
  )
    fail('Review the destination settings');
};
// Provider-specific rules stay here. Scheduling, rights and signing are generic.
const adapters = {
  youtube: {
    ready: true,
    settings(settings) {
      onlyKeys(settings, ['title', 'type', 'selfDeclaredMadeForKids', 'tags']);
      if (
        typeof settings.title !== 'string' ||
        settings.title.length < 2 ||
        settings.title.length > 100 ||
        /[<>\x00-\x1f]/.test(settings.title)
      )
        fail('Set a YouTube title between 2 and 100 characters');
      if (!['private', 'unlisted', 'public'].includes(settings.type))
        fail('Choose YouTube visibility');
      if (!['yes', 'no'].includes(settings.selfDeclaredMadeForKids))
        fail('Choose whether the video is made for children');
      const tags = settings.tags || [];
      if (
        !Array.isArray(tags) ||
        tags.length > 30 ||
        tags.some(
          (tag) => typeof tag !== 'string' || !tag.length || tag.length > 100
        ) ||
        tags.reduce(
          (sum, tag) => sum + tag.length + (/\s/.test(tag) ? 2 : 0),
          0
        ) > 500
      )
        fail('Review YouTube tags');
      return {
        title: settings.title,
        type: settings.type,
        selfDeclaredMadeForKids: settings.selfDeclaredMadeForKids,
        tags: tags.map((tag) => ({ value: tag, label: tag })),
      };
    },
    validate(content) {
      if (content.length > 5000)
        fail('Shorten the YouTube description to 5000 characters');
    },
  },
  instagram: {
    ready: true,
    settings(settings) {
      onlyKeys(settings, ['post_type']);
      if (settings.post_type !== 'post') fail('Select an Instagram reel post');
      return { post_type: 'post' };
    },
    validate(content) {
      if (content.length > 2200)
        fail('Shorten the Instagram caption to 2200 characters');
    },
  },
  discord: {
    ready: true,
    settings(settings, options) {
      onlyKeys(settings, ['channel']);
      if (
        !/^\d{17,20}$/.test(settings.channel || '') ||
        !options.allowedDiscordChannels.includes(settings.channel)
      )
        fail('Choose an approved Discord announcement channel');
      return { channel: settings.channel };
    },
    validate(content) {
      if (content.length > 2000)
        fail('Shorten the Discord message to 2000 characters');
      if (/@everyone|@here|<@(?:!|&)?\d+>/.test(content))
        fail('Remove Discord mentions before publishing');
    },
  },
  tiktok: {
    ready: false,
    reason:
      'Manual handoff required. This private team uploader has no approved public Direct Post route.',
  },
};
export function platformFor(identifier) {
  if (identifier === 'instagram-standalone') return 'instagram';
  return Object.hasOwn(adapters, identifier) ? identifier : null;
}
export function capabilities(platform, options) {
  const adapter = adapters[platform];
  if (!adapter)
    return { ready: false, reason: 'This destination is not enabled' };
  if (platform === 'discord' && !options.allowedDiscordChannels.length)
    return {
      ready: false,
      reason: 'The owner must whitelist a Discord announcement channel',
    };
  return {
    ready: adapter.ready,
    manualRequired: platform === 'tiktok',
    reason: adapter.reason || null,
  };
}
export function nativeCapabilities(identifier, options) {
  if (identifier === 'discord')
    return {
      ready: false,
      manualRequired: true,
      reason: 'Use the dedicated channel webhook for Discord announcements',
    };
  return capabilities(platformFor(identifier), options);
}
export function reviewedSettings(platform, settings, content, options) {
  const capability = capabilities(platform, options);
  if (!capability.ready) fail(capability.reason);
  adapters[platform].validate(content);
  return adapters[platform].settings(settings, options);
}
