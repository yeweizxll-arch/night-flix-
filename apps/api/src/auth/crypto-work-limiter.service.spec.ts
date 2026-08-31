import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { CryptoWorkLimiterService } from './crypto-work-limiter.service';

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('CryptoWorkLimiterService', () => {
  afterEach(() => {
    delete process.env.AUTH_SCRYPT_CONCURRENCY;
    delete process.env.AUTH_SCRYPT_QUEUE_MAX;
  });

  it('never exceeds its concurrency and drains queued work in FIFO order', async () => {
    process.env.AUTH_SCRYPT_CONCURRENCY = '2';
    process.env.AUTH_SCRYPT_QUEUE_MAX = '2';
    const limiter = new CryptoWorkLimiterService();
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0;
    let maximumActive = 0;

    const work = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await gate.promise;
        } finally {
          active -= 1;
        }
      }),
    );

    expect(started).toEqual([0, 1]);
    gates[0]?.resolve(0);
    await expect(work[0]).resolves.toBe(0);
    expect(started).toEqual([0, 1, 2]);

    gates[1]?.resolve(1);
    await expect(work[1]).resolves.toBe(1);
    expect(started).toEqual([0, 1, 2, 3]);

    gates[2]?.resolve(2);
    gates[3]?.resolve(3);
    await expect(Promise.all(work)).resolves.toEqual([0, 1, 2, 3]);
    expect(maximumActive).toBe(2);
  });

  it('rejects immediately when both the active slots and queue are full', async () => {
    process.env.AUTH_SCRYPT_CONCURRENCY = '1';
    process.env.AUTH_SCRYPT_QUEUE_MAX = '1';
    const limiter = new CryptoWorkLimiterService();
    const firstGate = deferred<string>();
    const first = limiter.run(() => firstGate.promise);
    const second = limiter.run(async () => 'second');

    expect(() => limiter.run(async () => 'overflow')).toThrow(
      ServiceUnavailableException,
    );

    firstGate.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('releases a slot after failed work and continues draining the queue', async () => {
    process.env.AUTH_SCRYPT_CONCURRENCY = '1';
    process.env.AUTH_SCRYPT_QUEUE_MAX = '1';
    const limiter = new CryptoWorkLimiterService();
    const firstGate = deferred<string>();
    const first = limiter.run(() => firstGate.promise);
    const second = limiter.run(async () => 'recovered');
    const failure = new Error('scrypt failed');

    firstGate.reject(failure);
    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('recovered');
  });
});
