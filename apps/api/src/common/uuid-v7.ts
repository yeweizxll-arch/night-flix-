import { randomBytes } from 'node:crypto';

const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;

/**
 * Generates a UUIDv7-compatible identifier using the current Unix timestamp and
 * 74 random bits. Database IDs stay time-sortable without relying on extensions.
 */
export function uuidV7(nowMs = Date.now()): string {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_UUID_V7_TIMESTAMP
  ) {
    throw new RangeError('UUIDv7 timestamp is outside the 48-bit range');
  }

  const bytes = randomBytes(16);
  let timestamp = BigInt(nowMs);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

