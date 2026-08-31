import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PASSWORD_HASH_OPTIONS,
  hashPassword,
  needsPasswordRehash,
  verifyPassword,
} from './password';

describe('password hashing', () => {
  it('creates a salted versioned scrypt hash and verifies it', async () => {
    const first = await hashPassword('correct horse battery staple');
    const second = await hashPassword('correct horse battery staple');

    expect(first).toMatch(/^scrypt\$1\$N=32768,r=8,p=1,l=32\$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword('correct horse battery staple', first)).resolves.toBe(
      true,
    );
    await expect(verifyPassword('incorrect password', first)).resolves.toBe(false);
    expect(needsPasswordRehash(first)).toBe(false);
  });

  it('supports unicode passwords without normalization surprises', async () => {
    const encoded = await hashPassword('密码🔐é');

    await expect(verifyPassword('密码🔐é', encoded)).resolves.toBe(true);
    await expect(verifyPassword('密码🔐é', encoded)).resolves.toBe(false);
  });

  it('rejects invalid passwords and unsafe hash options', async () => {
    await expect(hashPassword('')).rejects.toThrow(RangeError);
    await expect(hashPassword('a'.repeat(4_097))).rejects.toThrow(RangeError);
    await expect(hashPassword(undefined as unknown as string)).rejects.toThrow(
      TypeError,
    );
    await expect(hashPassword('valid', { cost: 20_000 })).rejects.toThrow(
      /power of two/,
    );
    await expect(hashPassword('valid', { cost: 8_192 })).rejects.toThrow(RangeError);
    await expect(
      hashPassword('valid', { maxMemoryBytes: 32 * 1024 * 1024 }),
    ).rejects.toThrow(RangeError);
  });

  it('returns false for malformed, unsupported, or resource-heavy hashes', async () => {
    const malformedHashes = [
      '',
      'bcrypt$1$N=32768,r=8,p=1,l=32$salt$hash',
      'scrypt$2$N=32768,r=8,p=1,l=32$salt$hash',
      'scrypt$1$N=20000,r=8,p=1,l=32$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA',
      `scrypt$1$N=1048576,r=32,p=1,l=32$c2FsdHNhbHRzYWx0c2FsdA$${'a'.repeat(43)}`,
      'scrypt$1$N=32768,r=8,p=1,l=32$not+padded$aGFzaA',
    ];

    for (const malformed of malformedHashes) {
      await expect(verifyPassword('valid password', malformed)).resolves.toBe(false);
      expect(needsPasswordRehash(malformed)).toBe(true);
    }
  });

  it('detects hashes that no longer match the configured policy', async () => {
    const encoded = await hashPassword('policy password');

    expect(
      needsPasswordRehash(encoded, {
        ...DEFAULT_PASSWORD_HASH_OPTIONS,
        saltLength: 32,
      }),
    ).toBe(true);
  });
});
