import { hostname } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';

import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { RedisService } from '../redis/redis.service';

interface OutboxEventRow {
  aggregate_id: string;
  aggregate_type: string;
  event_key: string;
  event_type: string;
  event_version: number;
  headers_json: object;
  id: string;
  max_attempts: number;
  payload_json: object;
  retry_count: number;
  scope_type: 'platform' | 'tenant';
  tenant_id: string | null;
}

@Injectable()
export class OutboxPublisherService {
  private readonly batchSize = integerEnvironment('OUTBOX_BATCH_SIZE', 50, 1, 200);
  private readonly stream = streamName();
  private readonly workerId = workerIdentity();

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async recoverStaleLocks(): Promise<number> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{ count: number }>>`
        with recovered as (
          update outbox_events
          set
            status = case
              when retry_count >= max_attempts then 'dead_letter'
              else 'retry'
            end,
            locked_at = null,
            locked_by = null,
            available_at = statement_timestamp(),
            last_error = 'worker lock expired before publish confirmation'
          where status = 'processing'
            and locked_at < statement_timestamp() - interval '5 minutes'
          returning id
        )
        select count(*)::integer as count from recovered
      `;
      return rows[0]?.count ?? 0;
    });
  }

  async publishAvailable(): Promise<{ claimed: number; failed: number; published: number }> {
    const events = await this.claimBatch();
    let failed = 0;
    let published = 0;
    for (const event of events) {
      try {
        await this.redis.appendStream(this.stream, {
          aggregateId: event.aggregate_id,
          aggregateType: event.aggregate_type,
          eventId: event.id,
          eventKey: event.event_key,
          eventType: event.event_type,
          eventVersion: String(event.event_version),
          headers: JSON.stringify(event.headers_json),
          payload: JSON.stringify(event.payload_json),
          scope: event.scope_type,
          tenantId: event.tenant_id ?? '',
        });
        await this.markPublished(event.id);
        published += 1;
      } catch (error) {
        await this.markFailed(event, safeErrorMessage(error));
        failed += 1;
      }
    }
    return { claimed: events.length, failed, published };
  }

  private claimBatch(): Promise<OutboxEventRow[]> {
    return this.database.inPlatformContext(async (transaction) => {
      return transaction<OutboxEventRow[]>`
        with candidates as (
          select id
          from outbox_events
          where status in ('pending', 'retry')
            and available_at <= statement_timestamp()
          order by available_at, created_at, id
          for update skip locked
          limit ${this.batchSize}
        )
        update outbox_events as event
        set
          status = 'processing',
          locked_at = statement_timestamp(),
          locked_by = ${this.workerId},
          last_error = null
        from candidates
        where event.id = candidates.id
        returning
          event.id,
          event.scope_type,
          event.tenant_id,
          event.event_key,
          event.aggregate_type,
          event.aggregate_id,
          event.event_type,
          event.event_version,
          event.payload_json,
          event.headers_json,
          event.retry_count,
          event.max_attempts
      `;
    });
  }

  private markPublished(eventId: string): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update outbox_events
        set
          status = 'published',
          published_at = statement_timestamp(),
          locked_at = null,
          locked_by = null,
          last_error = null
        where id = ${eventId}
          and status = 'processing'
          and locked_by = ${this.workerId}
      `;
    });
  }

  private markFailed(event: OutboxEventRow, message: string): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      await this.updateFailure(transaction, event, message);
    });
  }

  private async updateFailure(
    transaction: DatabaseTransaction,
    event: OutboxEventRow,
    message: string,
  ): Promise<void> {
    const nextRetryCount = event.retry_count + 1;
    const deadLetter = nextRetryCount >= event.max_attempts;
    const delaySeconds = Math.min(3_600, 2 ** Math.min(nextRetryCount, 10));
    await transaction`
      update outbox_events
      set
        status = ${deadLetter ? 'dead_letter' : 'retry'},
        retry_count = ${nextRetryCount},
        available_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_at = null,
        locked_by = null,
        last_error = ${message}
      where id = ${event.id}
        and status = 'processing'
        and locked_by = ${this.workerId}
    `;
  }
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function streamName(): string {
  const value = process.env.OUTBOX_STREAM_KEY?.trim() || 'drama:events';
  if (!/^[a-zA-Z0-9:._-]{3,128}$/.test(value)) {
    throw new Error('OUTBOX_STREAM_KEY is invalid');
  }
  return value;
}

function workerIdentity(): string {
  const configured = process.env.WORKER_ID?.trim();
  const value = configured || `${hostname()}:${process.pid}`;
  if (value.length > 200 || !value) throw new Error('WORKER_ID is invalid');
  return value;
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Unknown publish failure';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 4_000) || 'Unknown publish failure';
}
