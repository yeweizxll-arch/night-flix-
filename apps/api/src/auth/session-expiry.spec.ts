import { describe, expect, it } from 'vitest';

import {
  canRefreshSession,
  createSessionExpiryWindow,
  DEFAULT_SESSION_EXPIRY_POLICY,
  getSessionExpiryStatus,
  renewSessionExpiryWindow,
  type SessionExpiryPolicy,
} from './session-expiry';

const testPolicy: SessionExpiryPolicy = {
  accessTokenTtlMs: 10,
  refreshTokenIdleTtlMs: 50,
  absoluteSessionTtlMs: 100,
};

describe('session expiry policy', () => {
  it('uses short-lived access, sliding refresh, and absolute expirations', () => {
    expect(DEFAULT_SESSION_EXPIRY_POLICY).toEqual({
      accessTokenTtlMs: 15 * 60 * 1_000,
      refreshTokenIdleTtlMs: 7 * 24 * 60 * 60 * 1_000,
      absoluteSessionTtlMs: 30 * 24 * 60 * 60 * 1_000,
    });

    expect(createSessionExpiryWindow(1_000, testPolicy)).toEqual({
      createdAtMs: 1_000,
      accessTokenExpiresAtMs: 1_010,
      refreshTokenExpiresAtMs: 1_050,
      absoluteExpiresAtMs: 1_100,
    });
  });

  it('distinguishes access, refresh, absolute, and revoked states at boundaries', () => {
    const window = createSessionExpiryWindow(1_000, testPolicy);

    expect(getSessionExpiryStatus(window, 1_009)).toBe('active');
    expect(getSessionExpiryStatus(window, 1_010)).toBe('access-expired');
    expect(getSessionExpiryStatus(window, 1_050)).toBe('refresh-expired');
    expect(getSessionExpiryStatus(window, 1_100)).toBe('absolute-expired');
    expect(getSessionExpiryStatus(window, 1_001, true)).toBe('revoked');
    expect(canRefreshSession(window, 1_010)).toBe(true);
    expect(canRefreshSession(window, 1_050)).toBe(false);
    expect(canRefreshSession(window, 1_001, true)).toBe(false);
  });

  it('slides refresh expiration but never extends the absolute lifetime', () => {
    const original = createSessionExpiryWindow(1_000, testPolicy);
    const renewed = renewSessionExpiryWindow(original, 1_049, testPolicy);

    expect(renewed).toEqual({
      createdAtMs: 1_000,
      accessTokenExpiresAtMs: 1_059,
      refreshTokenExpiresAtMs: 1_099,
      absoluteExpiresAtMs: 1_100,
    });

    const finalRenewal = renewSessionExpiryWindow(renewed, 1_098, testPolicy);
    expect(finalRenewal.accessTokenExpiresAtMs).toBe(1_100);
    expect(finalRenewal.refreshTokenExpiresAtMs).toBe(1_100);
  });

  it('rejects unsafe policies, timestamps, windows, and expired renewal', () => {
    expect(() => createSessionExpiryWindow(-1, testPolicy)).toThrow(RangeError);
    expect(() =>
      createSessionExpiryWindow(1_000, { ...testPolicy, accessTokenTtlMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createSessionExpiryWindow(1_000, {
        ...testPolicy,
        accessTokenTtlMs: 51,
      }),
    ).toThrow(/cannot exceed/);
    expect(() =>
      createSessionExpiryWindow(1_000, {
        ...testPolicy,
        refreshTokenIdleTtlMs: 101,
      }),
    ).toThrow(/cannot exceed/);

    const expired = createSessionExpiryWindow(1_000, testPolicy);
    expect(() => renewSessionExpiryWindow(expired, 1_050, testPolicy)).toThrow(
      /refresh-expired/,
    );
    expect(() =>
      getSessionExpiryStatus(
        { ...expired, refreshTokenExpiresAtMs: 999 },
        1_001,
      ),
    ).toThrow(/inconsistent/);
  });
});
