import { describe, expect, it } from 'vitest';

import { sanitizeAuditJson } from './audit-sanitizer';

describe('sanitizeAuditJson', () => {
  it('recursively redacts credential, token, OTP, and raw webhook fields', () => {
    const sanitized = sanitizeAuditJson({
      credentials: { apiKey: 'key-value', publicId: 'safe-id' },
      metadata: {
        access_token: 'access-value',
        nested: [{ OTP: '8888', title: 'safe-title' }],
        rawWebhookPayload: '{"card":"secret"}',
        refreshToken: 'refresh-value',
      },
      passwordHash: 'hash-value',
      unchanged: 'safe-value',
    });

    expect(sanitized).toEqual({
      credentials: '[REDACTED]',
      metadata: {
        access_token: '[REDACTED]',
        nested: [{ OTP: '[REDACTED]', title: 'safe-title' }],
        rawWebhookPayload: '[REDACTED]',
        refreshToken: '[REDACTED]',
      },
      passwordHash: '[REDACTED]',
      unchanged: 'safe-value',
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/access-value|refresh-value|8888|card/);
  });

  it('caps depth and replaces oversized sanitized JSON without returning partial values', () => {
    let nested: Record<string, unknown> = { visible: 'leaf' };
    for (let depth = 0; depth < 12; depth += 1) nested = { child: nested };
    expect(JSON.stringify(sanitizeAuditJson(nested))).toContain('maximum depth reached');

    const oversized = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field${index}`, 'x'.repeat(4_000)]),
    );
    expect(sanitizeAuditJson(oversized)).toEqual({
      _truncated: 'audit JSON exceeded the response size limit',
    });
  });
});
