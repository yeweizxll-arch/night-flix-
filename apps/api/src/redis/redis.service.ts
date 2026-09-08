import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: RedisClientType | undefined;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('REDIS_URL is required in production');
      }
      return;
    }
    if (process.env.NODE_ENV === 'production' && !url.startsWith('rediss://')) {
      throw new Error('Production REDIS_URL must use rediss:// TLS');
    }
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 3000 },
    });
    this.client.on('error', () => {
      // Connection state is reported by readiness; never log credentials from URLs.
    });
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  async onModuleInit(): Promise<void> {
    await this.client?.connect();
  }

  async incrementWindow(key: string, windowMs: number): Promise<{
    count: number;
    ttlMs: number;
  }> {
    if (!this.client?.isReady) {
      throw new Error('Redis is not ready');
    }
    const result = (await this.client.eval(
      `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then
          redis.call('PEXPIRE', KEYS[1], ARGV[1])
        end
        return { count, redis.call('PTTL', KEYS[1]) }
      `,
      { arguments: [String(windowMs)], keys: [key] },
    )) as [number, number];
    return { count: Number(result[0]), ttlMs: Number(result[1]) };
  }

  async reserveWindowsOnce(
    markerKey: string,
    checks: readonly { key: string; windowMs: number }[],
  ): Promise<{ alreadyReserved: boolean; results: Array<{ count: number; ttlMs: number }> }> {
    if (!this.client?.isReady) throw new Error('Redis is not ready');
    if (!checks.length) return { alreadyReserved: false, results: [] };
    const result = (await this.client.eval(
      `
        if redis.call('EXISTS', KEYS[1]) == 1 then
          return {1}
        end
        local output = {0}
        local marker_ttl = 0
        for index = 2, #KEYS do
          local ttl = tonumber(ARGV[index - 1])
          local count = redis.call('INCR', KEYS[index])
          if count == 1 then redis.call('PEXPIRE', KEYS[index], ttl) end
          table.insert(output, count)
          table.insert(output, redis.call('PTTL', KEYS[index]))
          if ttl > marker_ttl then marker_ttl = ttl end
        end
        redis.call('SET', KEYS[1], '1', 'PX', marker_ttl, 'NX')
        return output
      `,
      {
        arguments: checks.map((check) => String(check.windowMs)),
        keys: [markerKey, ...checks.map((check) => check.key)],
      },
    )) as number[];
    if (Number(result[0]) === 1) return { alreadyReserved: true, results: [] };
    const results: Array<{ count: number; ttlMs: number }> = [];
    for (let index = 1; index < result.length; index += 2) {
      results.push({ count: Number(result[index]), ttlMs: Number(result[index + 1]) });
    }
    return { alreadyReserved: false, results };
  }

  async ping(): Promise<boolean> {
    return this.client?.isReady ? (await this.client.ping()) === 'PONG' : false;
  }

  async appendStream(
    stream: string,
    fields: Record<string, string>,
    maximumLength = 100_000,
  ): Promise<string> {
    if (!this.client?.isReady) {
      throw new Error('Redis is not ready');
    }
    const id = await this.client.xAdd(stream, '*', fields, {
      TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: maximumLength },
    });
    return id;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client?.isOpen) {
      await this.client.quit();
    }
  }
}
