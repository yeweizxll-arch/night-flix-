import { describe, expect, it } from 'vitest';

import { uuidV7 } from './uuid-v7';

describe('uuidV7', () => {
  it('creates an RFC-compatible version 7 UUID with the supplied timestamp', () => {
    const timestamp = 1_725_000_000_123;
    const value = uuidV7(timestamp);

    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const encodedTimestamp = Number.parseInt(value.replaceAll('-', '').slice(0, 12), 16);
    expect(encodedTimestamp).toBe(timestamp);
  });

  it('uses random bits for identifiers created in the same millisecond', () => {
    expect(uuidV7(1_000)).not.toBe(uuidV7(1_000));
  });

  it('rejects invalid timestamps', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
