import { Injectable, ServiceUnavailableException } from '@nestjs/common';

interface QueuedWork<T> {
  execute: () => Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

@Injectable()
export class CryptoWorkLimiterService {
  private active = 0;
  private readonly maximumConcurrent = positiveInteger(
    process.env.AUTH_SCRYPT_CONCURRENCY,
    4,
    32,
  );
  private readonly maximumQueue = positiveInteger(
    process.env.AUTH_SCRYPT_QUEUE_MAX,
    100,
    1_000,
  );
  private readonly queue: QueuedWork<unknown>[] = [];

  run<T>(execute: () => Promise<T>): Promise<T> {
    if (this.active < this.maximumConcurrent) {
      return this.start(execute);
    }
    if (this.queue.length >= this.maximumQueue) {
      throw new ServiceUnavailableException({
        code: 'AUTH_CRYPTO_BUSY',
        message: 'Authentication is temporarily busy',
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ execute, reject, resolve } as QueuedWork<unknown>);
    });
  }

  private async start<T>(execute: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await execute();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) {
        void this.start(next.execute).then(next.resolve, next.reject);
      }
    }
  }
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Authentication concurrency setting must be between 1 and ${maximum}`);
  }
  return value;
}

