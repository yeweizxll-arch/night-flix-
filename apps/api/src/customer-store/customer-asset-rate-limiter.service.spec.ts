import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { CustomerAssetRateLimiterService } from './customer-asset-rate-limiter.service';

const originalNodeEnv = process.env.NODE_ENV;
const originalSecret = process.env.RATE_LIMIT_KEY_SECRET;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalSecret === undefined) delete process.env.RATE_LIMIT_KEY_SECRET;
  else process.env.RATE_LIMIT_KEY_SECRET = originalSecret;
  vi.restoreAllMocks();
});

describe('CustomerAssetRateLimiterService', () => {
  it('does not put raw IP addresses in Redis keys', async () => {
    const incrementWindow = vi.fn(async (_key: string, _windowMs: number) => ({
      count: 1,
      ttlMs: 60_000,
    }));
    const limiter = new CustomerAssetRateLimiterService({
      configured: true,
      incrementWindow,
    } as unknown as RedisService);
    await limiter.consume({
      ip: '203.0.113.8',
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(incrementWindow.mock.calls.map(([key]) => String(key)).join('\n'))
      .not.toContain('203.0.113.8');
  });

  it('fails closed without Redis or when Redis errors in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    await expect(new CustomerAssetRateLimiterService({ configured: false } as RedisService)
      .consume({
        ip: '203.0.113.8',
        tenantId: '11111111-1111-4111-8111-111111111111',
      })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const limiter = new CustomerAssetRateLimiterService({
      configured: true,
      incrementWindow: vi.fn().mockRejectedValue(new Error('redis secret=value')),
    } as unknown as RedisService);
    const error = await limiter.consume({
      ip: '203.0.113.8',
      tenantId: '11111111-1111-4111-8111-111111111111',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse()))
      .not.toContain('secret=value');
  });

  it('returns a stable 429 response when an IP exceeds its window', async () => {
    const limiter = new CustomerAssetRateLimiterService({
      configured: true,
      incrementWindow: vi.fn(async (key: string) => ({
        count: key.includes(':ip:') ? 601 : 1,
        ttlMs: 30_000,
      })),
    } as unknown as RedisService);
    const error = await limiter.consume({
      ip: '203.0.113.8',
      tenantId: '11111111-1111-4111-8111-111111111111',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'CUSTOMER_ASSET_RATE_LIMITED',
      retryAfterSeconds: 30,
    });
  });
});
