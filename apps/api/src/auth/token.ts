import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_ENTROPY_BYTES = 32;
const TOKEN_DIGEST_ALGORITHM = 'sha256';
const TOKEN_DIGEST_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;
const ACCESS_TOKEN_PREFIX = 'atk_';
const REFRESH_TOKEN_PREFIX = 'rtk_';

export type OpaqueTokenKind = 'access' | 'refresh';

export interface GeneratedOpaqueToken {
  kind: OpaqueTokenKind;
  token: string;
  digest: string;
}

function assertToken(token: string): void {
  if (typeof token !== 'string') {
    throw new TypeError('Token must be a string');
  }
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new RangeError(`Token must contain 1 to ${MAX_TOKEN_LENGTH} characters`);
  }
}

function tokenPrefix(kind: OpaqueTokenKind): string {
  if (kind === 'access') {
    return ACCESS_TOKEN_PREFIX;
  }
  if (kind === 'refresh') {
    return REFRESH_TOKEN_PREFIX;
  }

  throw new TypeError('Token kind must be access or refresh');
}

function parseDigest(encodedDigest: string): Buffer | undefined {
  if (typeof encodedDigest !== 'string') {
    return undefined;
  }

  const parts = encodedDigest.split('$');
  if (parts.length !== 2 || parts[0] !== TOKEN_DIGEST_ALGORITHM) {
    return undefined;
  }

  const value = parts[1] ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }

  const digest = Buffer.from(value, 'base64url');
  if (
    digest.length !== TOKEN_DIGEST_BYTES ||
    digest.toString('base64url') !== value
  ) {
    return undefined;
  }

  return digest;
}

export function digestToken(token: string): string {
  assertToken(token);
  const digest = createHash(TOKEN_DIGEST_ALGORITHM).update(token, 'utf8').digest();
  return `${TOKEN_DIGEST_ALGORITHM}$${digest.toString('base64url')}`;
}

export function verifyTokenDigest(token: string, encodedDigest: string): boolean {
  assertToken(token);
  const expectedDigest = parseDigest(encodedDigest);
  if (!expectedDigest) {
    return false;
  }

  const actualDigest = createHash(TOKEN_DIGEST_ALGORITHM)
    .update(token, 'utf8')
    .digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function generateOpaqueToken(kind: OpaqueTokenKind): GeneratedOpaqueToken {
  const token = `${tokenPrefix(kind)}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
  return { kind, token, digest: digestToken(token) };
}

export function generateAccessToken(): GeneratedOpaqueToken {
  return generateOpaqueToken('access');
}

export function generateRefreshToken(): GeneratedOpaqueToken {
  return generateOpaqueToken('refresh');
}
