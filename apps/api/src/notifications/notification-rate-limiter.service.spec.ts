import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { NotificationRateLimiterService } from './notification-rate-limiter.service';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe('NotificationRateLimiterService', () => {
  it('fails closed in production when Redis is not configured', async () => {
    process.env.NODE_ENV = 'production';
    const limiter = new NotificationRateLimiterService({ configured: false } as RedisService);
    await expect(limiter.consume({
      accountId: 'account', category: 'marketing', deliveryId: 'delivery', tenantId: 'tenant',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reserves a delivery quota only once across retries', async () => {
    const reserveWindowsOnce = vi.fn()
      .mockResolvedValueOnce({ alreadyReserved: false,
        results: [{ count: 1, ttlMs: 1000 }, { count: 1, ttlMs: 1000 }] })
      .mockResolvedValueOnce({ alreadyReserved: true, results: [] });
    const limiter = new NotificationRateLimiterService({
      configured: true, reserveWindowsOnce,
    } as unknown as RedisService);
    const input = {
      accountId: 'account', category: 'marketing' as const,
      deliveryId: 'delivery', tenantId: 'tenant',
    };
    await limiter.consume(input);
    await limiter.consume(input);
    expect(reserveWindowsOnce).toHaveBeenCalledTimes(2);
    expect(reserveWindowsOnce.mock.calls[0]?.[0]).toContain('delivery');
  });

  it('keeps marketing and transactional counters separate', async () => {
    const reserveWindowsOnce = vi.fn().mockResolvedValue({
      alreadyReserved: false,
      results: [{ count: 1, ttlMs: 1000 }, { count: 1, ttlMs: 1000 }],
    });
    const limiter = new NotificationRateLimiterService({
      configured: true, reserveWindowsOnce,
    } as unknown as RedisService);
    await limiter.consume({ accountId: 'a', category: 'marketing', deliveryId: 'm', tenantId: 't' });
    await limiter.consume({ accountId: 'a', category: 'transactional', deliveryId: 'x', tenantId: 't' });
    expect(reserveWindowsOnce.mock.calls[0]?.[0]).toContain('marketing');
    expect(reserveWindowsOnce.mock.calls[1]?.[0]).toContain('transactional');
  });
});
