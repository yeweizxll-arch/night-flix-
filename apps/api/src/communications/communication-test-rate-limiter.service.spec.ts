import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import type { RedisService } from '../redis/redis.service';
import { CommunicationTestRateLimiterService } from './communication-test-rate-limiter.service';

describe('CommunicationTestRateLimiterService', () => {
  const oldEnvironment = { ...process.env };
  afterEach(() => { process.env = { ...oldEnvironment }; });

  it('fails closed when production Redis is unconfigured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RATE_LIMIT_KEY_SECRET = 'x'.repeat(32);
    const limiter = new CommunicationTestRateLimiterService({ configured: false } as RedisService);
    await expect(limiter.consume({ actorId: 'staff', destination: 'test@example.com',
      ip: '203.0.113.4', tenantId: 'tenant' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
