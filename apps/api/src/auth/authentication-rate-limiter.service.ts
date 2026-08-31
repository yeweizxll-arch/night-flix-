import {
  Injectable,
  Inject,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';

import type { AccessScope } from '../access-control';
import { RedisService } from '../redis/redis.service';

interface MemoryCounter {
  count: number;
  expiresAt: number;
}

const WINDOW_MS = 5 * 60 * 1_000;
const MAX_MEMORY_KEYS = 5_000;

export type AuthenticationRateLimitOperation =
  | 'device_revoke'
  | 'login'
  | 'otp_create'
  | 'otp_verify'
  | 'password_change'
  | 'password_reset'
  | 'register';

const OPERATION_LIMITS: Record<AuthenticationRateLimitOperation, {
  identifier: number;
  ip: number;
  total: number;
}> = {
  device_revoke: { identifier: 10, ip: 30, total: 200 },
  login: { identifier: 8, ip: 30, total: 100 },
  otp_create: { identifier: 5, ip: 20, total: 150 },
  otp_verify: { identifier: 10, ip: 40, total: 300 },
  password_change: { identifier: 5, ip: 15, total: 100 },
  password_reset: { identifier: 5, ip: 20, total: 150 },
  register: { identifier: 3, ip: 10, total: 50 },
};

@Injectable()
export class AuthenticationRateLimiterService {
  private readonly memoryCounters = new Map<string, MemoryCounter>();
  private readonly keySecret = this.loadKeySecret();

  constructor(
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async consume(input: {
    ip?: string;
    login: string;
    operation?: AuthenticationRateLimitOperation;
    scope: AccessScope;
    tenantId?: string;
  }): Promise<void> {
    const operation = input.operation ?? 'login';
    const limits = OPERATION_LIMITS[operation];
    const scopeKey = input.scope === 'platform'
      ? 'platform'
      : `tenant:${input.tenantId ?? 'missing'}`;
    const checks = [
      {
        key: `auth:${operation}:ip:${this.hash(input.ip ?? 'unknown')}`,
        limit: limits.ip,
      },
      {
        key: `auth:${operation}:${scopeKey}:identifier:${this.hash(input.login)}`,
        limit: limits.identifier,
      },
      { key: `auth:${operation}:${scopeKey}:total`, limit: limits.total },
    ];

    let retryAfterMs = 0;
    try {
      if (!this.redis.configured && process.env.NODE_ENV === 'production') {
        throw new Error('Redis is not configured');
      }
      for (const check of checks) {
        const counter = this.redis.configured
          ? await this.redis.incrementWindow(check.key, WINDOW_MS)
          : this.incrementMemory(check.key);
        if (counter.count > check.limit) {
          retryAfterMs = Math.max(retryAfterMs, counter.ttlMs);
        }
      }
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'AUTH_RATE_LIMIT_UNAVAILABLE',
          message: 'Authentication is temporarily unavailable',
        });
      }
      return;
    }

    if (retryAfterMs > 0) {
      throw new HttpException(
        {
          code: 'AUTH_RATE_LIMITED',
          message: 'Too many authentication attempts; try again later',
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private incrementMemory(key: string): { count: number; ttlMs: number } {
    const now = Date.now();
    const existing = this.memoryCounters.get(key);
    const counter = !existing || existing.expiresAt <= now
      ? { count: 0, expiresAt: now + WINDOW_MS }
      : existing;
    counter.count += 1;
    this.memoryCounters.delete(key);
    this.memoryCounters.set(key, counter);

    while (this.memoryCounters.size > MAX_MEMORY_KEYS) {
      const oldest = this.memoryCounters.keys().next().value as string | undefined;
      if (!oldest) break;
      this.memoryCounters.delete(oldest);
    }
    return { count: counter.count, ttlMs: counter.expiresAt - now };
  }

  private hash(value: string): string {
    return createHmac('sha256', this.keySecret).update(value).digest('base64url');
  }

  private loadKeySecret(): string {
    const secret = process.env.RATE_LIMIT_KEY_SECRET;
    if (secret && Buffer.byteLength(secret, 'utf8') >= 32) {
      return secret;
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('RATE_LIMIT_KEY_SECRET must contain at least 32 bytes');
    }
    return 'development-only-rate-limit-key-not-for-production';
  }
}
