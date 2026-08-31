import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { RedisService } from '../redis/redis.service';

interface Counter { count: number; expiresAt: number }
const WINDOW_MS = 15 * 60 * 1_000;
const MAX_KEYS = 5_000;

@Injectable()
export class CommunicationTestRateLimiterService {
  private readonly memory = new Map<string, Counter>();
  private readonly key = loadSecret();

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async consume(input: { actorId: string; destination: string; ip?: string; tenantId: string }): Promise<void> {
    const checks = [
      { key: `comm-test:tenant:${input.tenantId}:staff:${input.actorId}`, limit: 10 },
      { key: `comm-test:ip:${this.hash(input.ip ?? 'unknown')}`, limit: 20 },
      { key: `comm-test:tenant:${input.tenantId}:destination:${this.hash(input.destination)}`, limit: 5 },
      { key: `comm-test:tenant:${input.tenantId}:total`, limit: 50 },
    ];
    let retryAfterMs = 0;
    try {
      if (!this.redis.configured && process.env.NODE_ENV === 'production') throw new Error('Redis unavailable');
      for (const check of checks) {
        const result = this.redis.configured
          ? await this.redis.incrementWindow(check.key, WINDOW_MS)
          : this.increment(check.key);
        if (result.count > check.limit) retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
      }
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'COMMUNICATION_RATE_LIMIT_UNAVAILABLE',
          message: 'Communication testing is temporarily unavailable',
        });
      }
      return;
    }
    if (retryAfterMs > 0) {
      throw new HttpException({ code: 'COMMUNICATION_TEST_RATE_LIMITED',
        message: 'Too many communication tests',
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) },
      HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private increment(key: string): { count: number; ttlMs: number } {
    const now = Date.now();
    const old = this.memory.get(key);
    const counter = !old || old.expiresAt <= now ? { count: 0, expiresAt: now + WINDOW_MS } : old;
    counter.count += 1;
    this.memory.delete(key);
    this.memory.set(key, counter);
    while (this.memory.size > MAX_KEYS) this.memory.delete(this.memory.keys().next().value as string);
    return { count: counter.count, ttlMs: counter.expiresAt - now };
  }

  private hash(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}

function loadSecret(): string {
  const value = process.env.RATE_LIMIT_KEY_SECRET;
  if (value && Buffer.byteLength(value) >= 32) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('RATE_LIMIT_KEY_SECRET must contain at least 32 bytes');
  return 'development-only-rate-limit-key-not-for-production';
}

