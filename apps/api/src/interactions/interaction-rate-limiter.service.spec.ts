import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { InteractionRateLimiterService } from './interaction-rate-limiter.service';

const originalNodeEnv = process.env.NODE_ENV;
const originalRateLimitSecret = process.env.RATE_LIMIT_KEY_SECRET;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalRateLimitSecret === undefined) delete process.env.RATE_LIMIT_KEY_SECRET;
  else process.env.RATE_LIMIT_KEY_SECRET = originalRateLimitSecret;
  vi.restoreAllMocks();
});

describe('InteractionRateLimiterService', () => {
  it('bounds writes independently by tenant, account, and IP in development memory', async () => {
    const limiter = new InteractionRateLimiterService({
      configured: false,
    } as RedisService);
    for (let index = 0; index < 12; index += 1) {
      await limiter.consume({
        accountId: '11111111-1111-4111-8111-111111111111',
        ip: '203.0.113.10',
        operation: 'comment',
        tenantId: '22222222-2222-4222-8222-222222222222',
      });
    }
    await expect(limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      ip: '203.0.113.10',
      operation: 'comment',
      tenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toBeInstanceOf(HttpException);

    await expect(limiter.consume({
      accountId: '33333333-3333-4333-8333-333333333333',
      ip: '203.0.113.11',
      operation: 'comment',
      tenantId: '44444444-4444-4444-8444-444444444444',
    })).resolves.toBeUndefined();
  });

  it('fails closed in production when Redis cannot enforce a limit', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const limiter = new InteractionRateLimiterService({
      configured: true,
      incrementWindow: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisService);
    await expect(limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      operation: 'report',
      tenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('falls back to bounded memory enforcement in development when Redis fails', async () => {
    process.env.NODE_ENV = 'development';
    const limiter = new InteractionRateLimiterService({
      configured: true,
      incrementWindow: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    } as unknown as RedisService);
    for (let index = 0; index < 6; index += 1) {
      await limiter.consume({
        accountId: '11111111-1111-4111-8111-111111111111',
        operation: 'report',
        tenantId: '22222222-2222-4222-8222-222222222222',
      });
    }
    await expect(limiter.consume({
      accountId: '11111111-1111-4111-8111-111111111111',
      operation: 'report',
      tenantId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toBeInstanceOf(HttpException);
  });
});
