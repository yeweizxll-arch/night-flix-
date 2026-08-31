const MINUTE_MS = 60 * 1_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_SESSION_TTL_MS = 365 * DAY_MS;

export interface SessionExpiryPolicy {
  accessTokenTtlMs: number;
  refreshTokenIdleTtlMs: number;
  absoluteSessionTtlMs: number;
}

export const DEFAULT_SESSION_EXPIRY_POLICY: Readonly<SessionExpiryPolicy> =
  Object.freeze({
    accessTokenTtlMs: 15 * MINUTE_MS,
    refreshTokenIdleTtlMs: 7 * DAY_MS,
    absoluteSessionTtlMs: 30 * DAY_MS,
  });

export interface SessionExpiryWindow {
  createdAtMs: number;
  accessTokenExpiresAtMs: number;
  refreshTokenExpiresAtMs: number;
  absoluteExpiresAtMs: number;
}

export type SessionExpiryStatus =
  | 'active'
  | 'access-expired'
  | 'refresh-expired'
  | 'absolute-expired'
  | 'revoked';

function assertTimestamp(timestampMs: number, name: string): void {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer timestamp`);
  }
}

function safeAddTimestamp(timestampMs: number, ttlMs: number): number {
  const result = timestampMs + ttlMs;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('Session expiration timestamp exceeds the safe integer range');
  }
  return result;
}

function resolvePolicy(
  supplied: Partial<SessionExpiryPolicy>,
): SessionExpiryPolicy {
  const policy = { ...DEFAULT_SESSION_EXPIRY_POLICY, ...supplied };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SESSION_TTL_MS) {
      throw new RangeError(`${name} must be a positive integer of at most one year`);
    }
  }

  if (policy.accessTokenTtlMs > policy.refreshTokenIdleTtlMs) {
    throw new RangeError('Access token TTL cannot exceed refresh token idle TTL');
  }
  if (policy.refreshTokenIdleTtlMs > policy.absoluteSessionTtlMs) {
    throw new RangeError('Refresh token idle TTL cannot exceed absolute session TTL');
  }

  return policy;
}

function assertExpiryWindow(window: SessionExpiryWindow): void {
  assertTimestamp(window.createdAtMs, 'createdAtMs');
  assertTimestamp(window.accessTokenExpiresAtMs, 'accessTokenExpiresAtMs');
  assertTimestamp(window.refreshTokenExpiresAtMs, 'refreshTokenExpiresAtMs');
  assertTimestamp(window.absoluteExpiresAtMs, 'absoluteExpiresAtMs');

  if (
    window.createdAtMs >= window.accessTokenExpiresAtMs ||
    window.accessTokenExpiresAtMs > window.refreshTokenExpiresAtMs ||
    window.refreshTokenExpiresAtMs > window.absoluteExpiresAtMs
  ) {
    throw new RangeError('Session expiry window is inconsistent');
  }
}

export function createSessionExpiryWindow(
  createdAtMs: number,
  suppliedPolicy: Partial<SessionExpiryPolicy> = {},
): SessionExpiryWindow {
  assertTimestamp(createdAtMs, 'createdAtMs');
  const policy = resolvePolicy(suppliedPolicy);
  const absoluteExpiresAtMs = safeAddTimestamp(
    createdAtMs,
    policy.absoluteSessionTtlMs,
  );
  const refreshTokenExpiresAtMs = Math.min(
    safeAddTimestamp(createdAtMs, policy.refreshTokenIdleTtlMs),
    absoluteExpiresAtMs,
  );
  const accessTokenExpiresAtMs = Math.min(
    safeAddTimestamp(createdAtMs, policy.accessTokenTtlMs),
    refreshTokenExpiresAtMs,
  );

  return {
    createdAtMs,
    accessTokenExpiresAtMs,
    refreshTokenExpiresAtMs,
    absoluteExpiresAtMs,
  };
}

export function getSessionExpiryStatus(
  window: SessionExpiryWindow,
  nowMs: number,
  revoked = false,
): SessionExpiryStatus {
  assertExpiryWindow(window);
  assertTimestamp(nowMs, 'nowMs');

  if (revoked) {
    return 'revoked';
  }
  if (nowMs >= window.absoluteExpiresAtMs) {
    return 'absolute-expired';
  }
  if (nowMs >= window.refreshTokenExpiresAtMs) {
    return 'refresh-expired';
  }
  if (nowMs >= window.accessTokenExpiresAtMs) {
    return 'access-expired';
  }
  return 'active';
}

export function canRefreshSession(
  window: SessionExpiryWindow,
  nowMs: number,
  revoked = false,
): boolean {
  const status = getSessionExpiryStatus(window, nowMs, revoked);
  return status === 'active' || status === 'access-expired';
}

export function renewSessionExpiryWindow(
  window: SessionExpiryWindow,
  nowMs: number,
  suppliedPolicy: Partial<SessionExpiryPolicy> = {},
): SessionExpiryWindow {
  assertExpiryWindow(window);
  assertTimestamp(nowMs, 'nowMs');
  const status = getSessionExpiryStatus(window, nowMs);
  if (status !== 'active' && status !== 'access-expired') {
    throw new Error(`Cannot renew a session that is ${status}`);
  }

  const policy = resolvePolicy(suppliedPolicy);
  const refreshTokenExpiresAtMs = Math.min(
    safeAddTimestamp(nowMs, policy.refreshTokenIdleTtlMs),
    window.absoluteExpiresAtMs,
  );
  const accessTokenExpiresAtMs = Math.min(
    safeAddTimestamp(nowMs, policy.accessTokenTtlMs),
    refreshTokenExpiresAtMs,
  );

  return {
    ...window,
    accessTokenExpiresAtMs,
    refreshTokenExpiresAtMs,
  };
}
