import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { AuthenticationRateLimiterService } from './authentication-rate-limiter.service';

describe('AuthenticationRateLimiterService', () => {
  afterEach(() => {
    delete process.env.NODE_ENV;
    delete process.env.RATE_LIMIT_KEY_SECRET;
  });

  it('limits repeated account attempts in the local development fallback', async () => {
    const redis = { configured: false } as RedisService;
    const limiter = new AuthenticationRateLimiterService(redis);
    const input = {
      ip: '192.0.2.10',
      login: 'admin@example.com',
      scope: 'platform' as const,
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(limiter.consume(input)).resolves.toBeUndefined();
    }
    await expect(limiter.consume(input)).rejects.toBeInstanceOf(HttpException);
  });

  it('separates account counters between tenants', async () => {
    const redis = { configured: false } as RedisService;
    const limiter = new AuthenticationRateLimiterService(redis);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await limiter.consume({
        ip: `192.0.2.${attempt}`,
        login: 'owner',
        scope: 'tenant',
        tenantId: 'tenant-a',
      });
    }
    await expect(
      limiter.consume({
        ip: '198.51.100.1',
        login: 'owner',
        scope: 'tenant',
        tenantId: 'tenant-b',
      }),
    ).resolves.toBeUndefined();
  });

  it('applies operation-specific OTP limits without consuming the login budget', async () => {
    const redis = { configured: false } as RedisService;
    const limiter = new AuthenticationRateLimiterService(redis);
    const base = {
      ip: '192.0.2.20',
      login: 'email:viewer@example.com',
      scope: 'tenant' as const,
      tenantId: 'tenant-a',
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(limiter.consume({
        ...base,
        operation: 'otp_create',
      })).resolves.toBeUndefined();
    }
    await expect(limiter.consume({
      ...base,
      operation: 'otp_create',
    })).rejects.toBeInstanceOf(HttpException);
    await expect(limiter.consume({
      ...base,
      operation: 'login',
    })).resolves.toBeUndefined();
  });

  it('limits password recovery independently from login attempts', async () => {
    const limiter = new AuthenticationRateLimiterService({ configured: false } as RedisService);
    const input = {
      ip: '192.0.2.40',
      login: 'email:viewer@example.com',
      operation: 'password_reset' as const,
      scope: 'tenant' as const,
      tenantId: 'tenant-a',
    };
    for (let attempt = 0; attempt < 5; attempt += 1) await limiter.consume(input);
    await expect(limiter.consume(input)).rejects.toBeInstanceOf(HttpException);
    await expect(limiter.consume({
      ...input,
      operation: 'login',
    })).resolves.toBeUndefined();
  });

  it('fails closed when distributed rate limiting is unavailable in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const redis = {
      configured: true,
      incrementWindow: vi.fn().mockRejectedValue(new Error('offline')),
    } as unknown as RedisService;
    const limiter = new AuthenticationRateLimiterService(redis);

    await expect(
      limiter.consume({ login: 'admin', scope: 'platform' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('fails closed in production when Redis is not configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const limiter = new AuthenticationRateLimiterService({
      configured: false,
    } as RedisService);
    await expect(limiter.consume({
      login: 'viewer@example.com',
      operation: 'password_reset',
      scope: 'tenant',
      tenantId: 'tenant-a',
    })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
