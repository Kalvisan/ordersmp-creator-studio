import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// This format matches CreatorPublishingGuard. Object keys use JavaScript's
// default UTF-16 sort; arrays retain their order. Hash the UTF-8 representation.
export function canonicalJson(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value))
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  throw new Error('Invalid reviewed content');
}
export const hashJson = (value) =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
export function mediaHash(body) {
  const manifest = [];
  if (!body?.posts?.length) throw new Error('A reviewed post is required');
  for (const post of body.posts)
    for (const value of post.value)
      for (const image of value.image) {
        if (!image.path || !/^[a-f0-9]{64}$/.test(image.sha256 || ''))
          throw new Error('Invalid media hash');
        manifest.push({ path: image.path, sha256: image.sha256 });
        if (image.thumbnail) {
          if (!/^[a-f0-9]{64}$/.test(image.thumbnailSha256 || ''))
            throw new Error('Invalid thumbnail hash');
          manifest.push({
            path: image.thumbnail,
            sha256: image.thumbnailSha256,
          });
        }
      }
  return hashJson(manifest);
}
export async function readSecret(filename) {
  if (!filename) throw new Error('Publishing credentials are not configured');
  const secret = (await readFile(filename, 'utf8')).trim();
  if (secret.length < 32 || secret.length > 4096)
    throw new Error('Invalid publishing credential');
  return secret;
}
export async function signApproval({
  body,
  orgId,
  permissionId,
  reviewerEmail,
  secretFile,
  now = Date.now(),
}) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: 1,
    approvalId: randomUUID(),
    method: 'POST',
    path: '/public/v1/posts',
    orgId,
    bodyHash: hashJson(body),
    mediaHash: mediaHash(body),
    permissionId,
    reviewerEmail,
    issuedAt,
    expiresAt: issuedAt + 120,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url'
  );
  return `${encoded}.${createHmac('sha256', await readSecret(secretFile))
    .update(encoded)
    .digest('base64url')}`;
}
