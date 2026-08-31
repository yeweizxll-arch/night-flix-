import { describe, expect, it } from 'vitest';

import {
  digestToken,
  generateAccessToken,
  generateOpaqueToken,
  generateRefreshToken,
  verifyTokenDigest,
} from './token';

describe('opaque tokens', () => {
  it('generates distinct cryptographically random access and refresh tokens', () => {
    const accessTokens = Array.from({ length: 100 }, () => generateAccessToken());
    const refresh = generateRefreshToken();

    expect(new Set(accessTokens.map(({ token }) => token))).toHaveLength(100);
    expect(accessTokens[0]?.token).toMatch(/^atk_[A-Za-z0-9_-]{43}$/);
    expect(refresh.token).toMatch(/^rtk_[A-Za-z0-9_-]{43}$/);
    expect(accessTokens[0]?.kind).toBe('access');
    expect(refresh.kind).toBe('refresh');
  });

  it('stores and verifies only a versioned SHA-256 digest', () => {
    const generated = generateAccessToken();

    expect(generated.digest).toMatch(/^sha256\$[A-Za-z0-9_-]{43}$/);
    expect(generated.digest).not.toContain(generated.token);
    expect(verifyTokenDigest(generated.token, generated.digest)).toBe(true);
    expect(verifyTokenDigest(`${generated.token}x`, generated.digest)).toBe(false);
    expect(digestToken(generated.token)).toBe(generated.digest);
  });

  it('rejects invalid token kinds, tokens, and digest encodings', () => {
    expect(() => generateOpaqueToken('admin' as never)).toThrow(TypeError);
    expect(() => digestToken('')).toThrow(RangeError);
    expect(() => digestToken(undefined as unknown as string)).toThrow(TypeError);

    const token = generateRefreshToken().token;
    expect(verifyTokenDigest(token, '')).toBe(false);
    expect(verifyTokenDigest(token, 'md5$abc')).toBe(false);
    expect(verifyTokenDigest(token, 'sha256$abc+def')).toBe(false);
    expect(verifyTokenDigest(token, `sha256$${'a'.repeat(43)}`)).toBe(false);
  });
});
