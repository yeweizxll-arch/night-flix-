import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import type { RedisService } from '../redis/redis.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness independently of external services', () => {
    const controller = new HealthController(
      {} as DatabaseService,
      {} as RedisService,
    );

    expect(controller.getLiveness()).toMatchObject({
      service: 'drama-saas-api',
      status: 'ok',
    });
  });

  it('rejects readiness when the database is unavailable', async () => {
    const database = { ping: vi.fn().mockResolvedValue(false) } as unknown as DatabaseService;
    const redis = { ping: vi.fn().mockResolvedValue(true) } as unknown as RedisService;
    const controller = new HealthController(database, redis);

    await expect(controller.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('reports readiness after the database responds', async () => {
    const database = { ping: vi.fn().mockResolvedValue(true) } as unknown as DatabaseService;
    const redis = { ping: vi.fn().mockResolvedValue(true) } as unknown as RedisService;
    const controller = new HealthController(database, redis);

    await expect(controller.getReadiness()).resolves.toMatchObject({
      checks: { database: 'ok', redis: 'ok' },
      status: 'ready',
    });
  });
});
