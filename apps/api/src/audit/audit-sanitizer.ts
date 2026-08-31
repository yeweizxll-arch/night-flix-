const REDACTED = '[REDACTED]';
const DEPTH_LIMIT = '[TRUNCATED: maximum depth reached]';
const NODE_LIMIT = '[TRUNCATED: node limit reached]';
const ARRAY_LIMIT = 100;
const KEY_LIMIT = 100;
const MAX_DEPTH = 8;
const MAX_NODES = 1_000;
const MAX_STRING_LENGTH = 4_000;
export const MAX_AUDIT_JSON_RESPONSE_BYTES = 32 * 1_024;

const SENSITIVE_KEY_PARTS = [
  'accesstoken',
  'apikey',
  'authorization',
  'ciphertext',
  'clientsecret',
  'checkoutreference',
  'checkouturl',
  'cookie',
  'credential',
  'encryptionkey',
  'otp',
  'password',
  'privatekey',
  'rawbody',
  'rawpayload',
  'rawwebhook',
  'refreshtoken',
  'secret',
  'signature',
  'token',
  'webhookbody',
  'webhookpayload',
] as const;

interface WalkBudget {
  nodes: number;
}

/**
 * Produces a response-safe copy. The original JSON value is never string-truncated,
 * because doing that could expose a partial credential.
 */
export function sanitizeAuditJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const sanitized = walk(value, 0, { nodes: 0 });
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_AUDIT_JSON_RESPONSE_BYTES) {
    return { _truncated: 'audit JSON exceeded the response size limit' };
  }
  return sanitized;
}

function walk(value: unknown, depth: number, budget: WalkBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return NODE_LIMIT;
  if (depth >= MAX_DEPTH && value !== null && typeof value === 'object') {
    return DEPTH_LIMIT;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]`;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const result = value.slice(0, ARRAY_LIMIT).map((entry) => walk(entry, depth + 1, budget));
    if (value.length > ARRAY_LIMIT) result.push('[TRUNCATED: array limit reached]');
    return result;
  }
  if (typeof value !== 'object') return String(value);

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries.slice(0, KEY_LIMIT)) {
    result[key] = isSensitiveKey(key) ? REDACTED : walk(entry, depth + 1, budget);
  }
  if (entries.length > KEY_LIMIT) {
    result._truncated = 'object key limit reached';
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}
