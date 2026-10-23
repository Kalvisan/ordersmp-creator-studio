import { ForbiddenException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';

export type CreatorRequest = Request & {
  user?: { id: string; email: string };
  org?: { id: string; users?: { role?: string; disabled?: boolean }[] };
};

type Approval = {
  v: 1;
  approvalId: string;
  method: string;
  path: string;
  orgId: string;
  bodyHash: string;
  mediaHash: string;
  permissionId: string;
  reviewerEmail: string;
  issuedAt: number;
  expiresAt: number;
};

const hashPattern = /^[a-f0-9]{64}$/;
const approvalIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Both the review gateway and verifier hash this representation, not HTTP
// whitespace. Array order and string contents are preserved, including Unicode.
export function canonicalCreatorJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalCreatorJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonicalCreatorJson((value as Record<string, unknown>)[key])
        )
        .join(',') +
      '}'
    );
  }
  throw new ForbiddenException('Invalid reviewed request');
}

export function creatorRequestHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalCreatorJson(value), 'utf8')
    .digest('hex');
}

export function creatorMediaHash(body: any): string {
  if (!Array.isArray(body?.posts) || !body.posts.length) {
    throw new ForbiddenException('A reviewed post is required');
  }
  const media: { path: string; sha256: string }[] = [];
  for (const post of body.posts) {
    if (!Array.isArray(post?.value) || !post.value.length) {
      throw new ForbiddenException('Invalid reviewed content');
    }
    for (const value of post.value) {
      if (!Array.isArray(value?.image)) {
        throw new ForbiddenException('A reviewed media manifest is required');
      }
      for (const image of value.image) {
        if (
          typeof image?.path !== 'string' ||
          !image.path ||
          !hashPattern.test(image.sha256 || '')
        ) {
          throw new ForbiddenException(
            'Every media file needs a reviewed SHA-256'
          );
        }
        media.push({ path: image.path, sha256: image.sha256 });
        if (image.thumbnail) {
          if (
            typeof image.thumbnail !== 'string' ||
            !hashPattern.test(image.thumbnailSha256 || '')
          ) {
            throw new ForbiddenException(
              'Every thumbnail needs a reviewed SHA-256'
            );
          }
          media.push({ path: image.thumbnail, sha256: image.thumbnailSha256 });
        }
      }
    }
  }
  // Text-only notices have the SHA-256 of [], rather than an absent hash.
  // The trusted signer checks actual bytes and immutable storage before review.
  return creatorRequestHash(media);
}

export function isCreatorOwner(user?: { email?: string }): boolean {
  const owner = process.env.GOOGLE_AUTH_OWNER_EMAIL?.trim().toLowerCase();
  return (
    !!owner &&
    typeof user?.email === 'string' &&
    user.email.trim().toLowerCase() === owner
  );
}

export class CreatorPublishingGuard {
  constructor(
    private readonly consumeNonce: (
      id: string,
      hash: string,
      ttl: number
    ) => Promise<boolean>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  private readSecret(): string {
    try {
      const path = process.env.CREATOR_PUBLISH_APPROVAL_SECRET_FILE;
      const secret = path
        ? readFileSync(path, 'utf8').trim()
        : process.env.NODE_ENV === 'test'
        ? process.env.CREATOR_PUBLISH_APPROVAL_SECRET?.trim()
        : undefined;
      if (!secret || secret.length < 32 || secret.length > 4096) {
        throw new Error('Invalid approval secret');
      }
      return secret;
    } catch {
      throw new ForbiddenException('Publishing review is unavailable');
    }
  }

  async verifyApproval(request: CreatorRequest): Promise<Approval> {
    const reject = () =>
      new ForbiddenException('A fresh owner publishing approval is required');
    // The review gateway retains future jobs and rechecks permission at their
    // dispatch time. Native repeating/future workflows cannot enforce revocation.
    if (
      request.body?.type !== 'now' ||
      request.body?.inter ||
      !Array.isArray(request.body?.posts) ||
      request.body.posts.some((post: any) => post?.date)
    )
      throw reject();
    const header = request.headers['x-creator-publish-approval'];
    if (typeof header !== 'string' || header.length > 4096) throw reject();
    const [encoded, signature, extra] = header.split('.');
    if (
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(encoded || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature || '')
    )
      throw reject();
    const expected = createHmac('sha256', this.readSecret())
      .update(encoded)
      .digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw reject();
    let approval: Approval;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded) throw reject();
      approval = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw reject();
    }
    const now = this.now();
    const path = request.path.replace(/\/+$/, '') || '/';
    if (
      !approval ||
      approval.v !== 1 ||
      !approvalIdPattern.test(approval.approvalId || '') ||
      approval.method !== request.method ||
      approval.path !== path ||
      !request.org?.id ||
      approval.orgId !== request.org.id ||
      !hashPattern.test(approval.bodyHash || '') ||
      !hashPattern.test(approval.mediaHash || '') ||
      typeof approval.permissionId !== 'string' ||
      !approval.permissionId.trim() ||
      approval.permissionId.length > 200 ||
      !isCreatorOwner({ email: approval.reviewerEmail }) ||
      !Number.isSafeInteger(approval.issuedAt) ||
      !Number.isSafeInteger(approval.expiresAt) ||
      approval.issuedAt > now ||
      approval.issuedAt < now - 120 ||
      approval.expiresAt <= now ||
      approval.expiresAt <= approval.issuedAt ||
      approval.expiresAt - approval.issuedAt > 120 ||
      approval.bodyHash !== creatorRequestHash(request.body) ||
      approval.mediaHash !== creatorMediaHash(request.body)
    )
      throw reject();
    try {
      if (
        !(await this.consumeNonce(
          approval.approvalId,
          approval.bodyHash,
          approval.expiresAt - now
        ))
      )
        throw reject();
    } catch {
      // A failed Redis operation must never fall back to replayable approval.
      throw reject();
    }
    return approval;
  }
}
