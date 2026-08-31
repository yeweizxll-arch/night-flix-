import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

export type NotificationCategory = 'marketing' | 'transactional';

interface Counter {
  count: number;
  expiresAt: number;
}

const MAX_MEMORY_KEYS = 20_000;
const POLICY = {
  marketing: { account: 10, tenant: 100_000, windowMs: 24 * 60 * 60 * 1_000 },
  transactional: { account: 100, tenant: 200_000, windowMs: 60 * 60 * 1_000 },
} as const;

export class NotificationFrequencyExceeded extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Notification frequency limit exceeded');
    this.name = 'NotificationFrequencyExceeded';
  }
}

@Injectable()
export class NotificationRateLimiterService {
  private readonly memory = new Map<string, Counter>();
  private readonly reservations = new Map<string, number>();

  constructor(
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async consume(input: {
    accountId: string;
    category: NotificationCategory;
    deliveryId: string;
    tenantId: string;
  }): Promise<void> {
    const policy = POLICY[input.category];
    const checks = [
      {
        key: `notification:${input.category}:tenant:${input.tenantId}:account:${input.accountId}`,
        limit: policy.account,
      },
      {
        key: `notification:${input.category}:tenant:${input.tenantId}:total`,
        limit: policy.tenant,
      },
    ];
    const markerKey = `notification:${input.category}:delivery:${input.deliveryId}`;
    let retryAfterMs = 0;
    try {
      if (!this.redis.configured && process.env.NODE_ENV === 'production') {
        throw new Error('Redis is not configured');
      }
      if (this.redis.configured) {
        const reservation = await this.redis.reserveWindowsOnce(
          markerKey,
          checks.map((check) => ({ key: check.key, windowMs: policy.windowMs })),
        );
        if (reservation.alreadyReserved) return;
        reservation.results.forEach((result, index) => {
          if (result.count > (checks[index]?.limit ?? 0)) {
            retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
          }
        });
      } else {
        retryAfterMs = this.consumeMemory(markerKey, checks, policy.windowMs);
      }
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'NOTIFICATION_RATE_LIMIT_UNAVAILABLE',
          message: 'Notification delivery is temporarily unavailable',
        });
      }
      retryAfterMs = this.consumeMemory(markerKey, checks, policy.windowMs);
    }
    if (retryAfterMs > 0) throw new NotificationFrequencyExceeded(retryAfterMs);
  }

  private consumeMemory(
    markerKey: string,
    checks: readonly { key: string; limit: number }[],
    windowMs: number,
  ): number {
    const now = Date.now();
    if ((this.reservations.get(markerKey) ?? 0) > now) return 0;
    this.reservations.set(markerKey, now + windowMs);
    let retryAfterMs = 0;
    for (const check of checks) {
      const result = this.incrementMemory(check.key, windowMs);
      if (result.count > check.limit) retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
    }
    while (this.reservations.size > MAX_MEMORY_KEYS) {
      const oldest = this.reservations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.reservations.delete(oldest);
    }
    return retryAfterMs;
  }

  private incrementMemory(key: string, windowMs: number): { count: number; ttlMs: number } {
    const now = Date.now();
    const existing = this.memory.get(key);
    const counter = !existing || existing.expiresAt <= now
      ? { count: 0, expiresAt: now + windowMs }
      : existing;
    counter.count += 1;
    this.memory.delete(key);
    this.memory.set(key, counter);
    while (this.memory.size > MAX_MEMORY_KEYS) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (!oldest) break;
      this.memory.delete(oldest);
    }
    return { count: counter.count, ttlMs: counter.expiresAt - now };
  }
}
