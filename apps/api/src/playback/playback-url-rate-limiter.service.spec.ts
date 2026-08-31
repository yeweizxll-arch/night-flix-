import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';

const originalNodeEnv = process.env.NODE_ENV;
const originalRateLimitSecret = process.env.RATE_LIMIT_KEY_SECRET;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalRateLimitSecret === undefined) delete process.env.RATE_LIMIT_KEY_SECRET;
  else process.env.RATE_LIMIT_KEY_SECRET = originalRateLimitSecret;
  vi.restoreAllMocks();
});

describe('PlaybackUrlRateLimiterService', () => {
  it('enforces the account dimension independently per tenant', async () => {
    const limiter = new PlaybackUrlRateLimiterService({ configured: false } as RedisService);
    const input = {
      accountId: '11111111-1111-4111-8111-111111111111',
      ip: '203.0.113.10',
      tenantId: '22222222-2222-4222-8222-222222222222',
    };
    for (let index = 0; index < 60; index += 1) await limiter.consume(input);
    await expect(limiter.consume(input)).rejects.toBeInstanceOf(HttpException);
    await expect(limiter.consume({
      ...input,
      ip: '203.0.113.11',
      tenantId: '33333333-3333-4333-8333-333333333333',
    })).resolves.toBeUndefined();
  });

  it('does not place raw account or IP identifiers in Redis keys', async () => {
    const incrementWindow = vi.fn(async (_key: string, _windowMs: number) => ({
      count: 1,
      ttlMs: 60_000,
    }));
    const limiter = new PlaybackUrlRateLimiterService({
      configured: true,
      incrementWindow,
    } as unknown as RedisService);
    await limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      ip: '203.0.113.10',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });
    const keys = incrementWindow.mock.calls.map(([key]) => String(key)).join('\n');
    expect(keys).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(keys).not.toContain('203.0.113.10');
  });

  it('fails closed in production when Redis is not configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const limiter = new PlaybackUrlRateLimiterService({ configured: false } as RedisService);
    await expect(limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      ip: '203.0.113.10',
      tenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed in production when Redis errors', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const limiter = new PlaybackUrlRateLimiterService({
      configured: true,
      incrementWindow: vi.fn().mockRejectedValue(new Error('redis offline secret=abc')),
    } as unknown as RedisService);
    await expect(limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      ip: '203.0.113.10',
      tenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toMatchObject({
      response: expect.not.stringContaining('secret=abc'),
    });
  });
});
