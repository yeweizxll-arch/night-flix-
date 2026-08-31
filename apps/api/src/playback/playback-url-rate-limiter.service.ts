import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { RedisService } from '../redis/redis.service';

interface Counter {
  count: number;
  expiresAt: number;
}

const WINDOW_MS = 60_000;
const MAX_MEMORY_KEYS = 20_000;
const LIMITS = { account: 60, ip: 180, tenant: 5_000 } as const;

@Injectable()
export class PlaybackUrlRateLimiterService {
  private readonly memory = new Map<string, Counter>();
  private readonly keySecret = rateLimitKeySecret();

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async consume(input: { accountId: string; ip: string; tenantId: string }): Promise<void> {
    const checks = [
      { key: `playback-url:ip:${this.digest(input.ip)}`, limit: LIMITS.ip },
      {
        key: `playback-url:tenant:${input.tenantId}:account:${this.digest(input.accountId)}`,
        limit: LIMITS.account,
      },
      { key: `playback-url:tenant:${input.tenantId}:total`, limit: LIMITS.tenant },
    ];
    let retryAfterMs = 0;
    try {
      if (!this.redis.configured && process.env.NODE_ENV === 'production') {
        throw new Error('Redis is not configured');
      }
      for (const check of checks) {
        const result = this.redis.configured
          ? await this.redis.incrementWindow(check.key, WINDOW_MS)
          : this.incrementMemory(check.key);
        if (result.count > check.limit) retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
      }
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'PLAYBACK_URL_RATE_LIMIT_UNAVAILABLE',
          message: 'Playback URL issuance is temporarily unavailable',
        });
      }
      retryAfterMs = 0;
      for (const check of checks) {
        const result = this.incrementMemory(check.key);
        if (result.count > check.limit) retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
      }
    }
    if (retryAfterMs > 0) {
      throw new HttpException({
        code: 'PLAYBACK_URL_RATE_LIMITED',
        message: 'Too many playback URL requests',
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private digest(value: string): string {
    return createHmac('sha256', this.keySecret).update(value).digest('base64url');
  }

  private incrementMemory(key: string): { count: number; ttlMs: number } {
    const now = Date.now();
    const current = this.memory.get(key);
    const counter = !current || current.expiresAt <= now
      ? { count: 0, expiresAt: now + WINDOW_MS }
      : current;
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

function rateLimitKeySecret(): string {
  const value = process.env.RATE_LIMIT_KEY_SECRET;
  if (value && Buffer.byteLength(value, 'utf8') >= 32) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RATE_LIMIT_KEY_SECRET must contain at least 32 bytes');
  }
  return 'development-only-playback-url-rate-key';
}
