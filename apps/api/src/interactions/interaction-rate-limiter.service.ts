import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { RedisService } from '../redis/redis.service';

type InteractionWriteOperation = 'bullet_comment' | 'comment' | 'report';

interface MemoryCounter {
  count: number;
  expiresAt: number;
}

const WINDOW_MS = 60_000;
const MAX_MEMORY_KEYS = 10_000;
const LIMITS: Record<InteractionWriteOperation, {
  account: number;
  ip: number;
  tenant: number;
}> = {
  comment: { account: 12, ip: 40, tenant: 1_000 },
  bullet_comment: { account: 30, ip: 100, tenant: 3_000 },
  report: { account: 6, ip: 20, tenant: 300 },
};

@Injectable()
export class InteractionRateLimiterService {
  private readonly memory = new Map<string, MemoryCounter>();
  private readonly secret = loadSecret();

  constructor(
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  async consume(input: {
    accountId: string;
    ip?: string;
    operation: InteractionWriteOperation;
    tenantId: string;
  }): Promise<void> {
    const limits = LIMITS[input.operation];
    const checks = [
      {
        key: `interaction:${input.operation}:ip:${this.hash(input.ip ?? 'unknown')}`,
        limit: limits.ip,
      },
      {
        key: `interaction:${input.operation}:tenant:${input.tenantId}:account:${this.hash(input.accountId)}`,
        limit: limits.account,
      },
      {
        key: `interaction:${input.operation}:tenant:${input.tenantId}:total`,
        limit: limits.tenant,
      },
    ];
    let retryAfterMs = 0;
    try {
      for (const check of checks) {
        const result = this.redis.configured
          ? await this.redis.incrementWindow(check.key, WINDOW_MS)
          : this.incrementMemory(check.key);
        if (result.count > check.limit) {
          retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
        }
      }
    } catch {
      if (process.env.NODE_ENV === 'production') {
        throw new ServiceUnavailableException({
          code: 'INTERACTION_RATE_LIMIT_UNAVAILABLE',
          message: 'Interaction writes are temporarily unavailable',
        });
      }
      retryAfterMs = 0;
      for (const check of checks) {
        const result = this.incrementMemory(check.key);
        if (result.count > check.limit) {
          retryAfterMs = Math.max(retryAfterMs, result.ttlMs);
        }
      }
    }
    if (retryAfterMs > 0) {
      throw new HttpException(
        {
          code: 'INTERACTION_RATE_LIMITED',
          message: 'Too many interaction writes; try again later',
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private incrementMemory(key: string): { count: number; ttlMs: number } {
    const now = Date.now();
    const existing = this.memory.get(key);
    const counter = !existing || existing.expiresAt <= now
      ? { count: 0, expiresAt: now + WINDOW_MS }
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

  private hash(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}

function loadSecret(): string {
  const secret = process.env.RATE_LIMIT_KEY_SECRET;
  if (secret && Buffer.byteLength(secret, 'utf8') >= 32) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RATE_LIMIT_KEY_SECRET must contain at least 32 bytes');
  }
  return 'development-only-rate-limit-key-not-for-production';
}
