import { describe, expect, it, vi } from 'vitest';

import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service';
import type { RedisService } from '../redis/redis.service';
import { OutboxPublisherService } from './outbox-publisher.service';

const baseEvent = {
  aggregate_id: '018f2f48-6a9d-7b23-8c4d-1234567890ab',
  aggregate_type: 'drama',
  event_key: 'event:018f2f48-6a9d-7b23-8c4d-1234567890ac',
  event_type: 'ContentSubmitted',
  event_version: 1,
  headers_json: {},
  id: '018f2f48-6a9d-7b23-8c4d-1234567890ac',
  max_attempts: 10,
  payload_json: { dramaId: '018f2f48-6a9d-7b23-8c4d-1234567890ab' },
  retry_count: 0,
  scope_type: 'tenant' as const,
  tenant_id: '018f2f48-6a9d-7b23-8c4d-1234567890ad',
};

function setup(events = [baseEvent]) {
  const updates: Array<{ sql: string; values: unknown[] }> = [];
  const transaction = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (sql.includes('returning\n          event.id')) return events;
    updates.push({ sql, values });
    if (sql.includes('select count(*)::integer as count')) return [{ count: 2 }];
    return [];
  }) as unknown as DatabaseTransaction;
  const database = {
    inPlatformContext: vi.fn(async <T>(
      callback: (value: DatabaseTransaction) => Promise<T>,
    ) => callback(transaction)),
  } as unknown as DatabaseService;
  const redis = {
    appendStream: vi.fn().mockResolvedValue('1-0'),
  } as unknown as RedisService;
  return {
    publisher: new OutboxPublisherService(database, redis),
    redis,
    updates,
  };
}

describe('OutboxPublisherService', () => {
  it('publishes a claimed event with its stable idempotency identity', async () => {
    const { publisher, redis, updates } = setup();

    await expect(publisher.publishAvailable()).resolves.toEqual({
      claimed: 1,
      failed: 0,
      published: 1,
    });
    expect(redis.appendStream).toHaveBeenCalledWith(
      'drama:events',
      expect.objectContaining({
        eventId: baseEvent.id,
        eventKey: baseEvent.event_key,
        eventType: baseEvent.event_type,
        tenantId: baseEvent.tenant_id,
      }),
    );
    expect(updates.some((entry) => entry.sql.includes("status = 'published'"))).toBe(true);
  });

  it('moves the final failed attempt to the dead-letter state', async () => {
    const event = { ...baseEvent, retry_count: 9 };
    const { publisher, redis, updates } = setup([event]);
    vi.mocked(redis.appendStream).mockRejectedValueOnce(new Error('redis\nsecret-free failure'));

    await expect(publisher.publishAvailable()).resolves.toEqual({
      claimed: 1,
      failed: 1,
      published: 0,
    });
    const failure = updates.find((entry) => entry.sql.includes('retry_count ='));
    expect(failure?.values).toEqual(expect.arrayContaining([
      'dead_letter',
      10,
      'redis secret-free failure',
      event.id,
    ]));
  });

  it('recovers abandoned processing locks for retry', async () => {
    const { publisher } = setup([]);
    await expect(publisher.recoverStaleLocks()).resolves.toBe(2);
  });
});
