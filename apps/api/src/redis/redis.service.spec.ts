import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisService } from './redis.service';

const client = vi.hoisted(() => ({ on: vi.fn(), isReady: false, eval: vi.fn() }));
const create = vi.hoisted(() => vi.fn());
vi.mock('redis', () => ({ createClient: create }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('Redis failure backpressure', () => {
  it('bounds pending commands, disables disconnected replay, and limits command waits', () => {
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    create.mockReturnValue(client);
    new RedisService();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      disableOfflineQueue: true, commandsQueueMaxLength: 1000,
      commandOptions: { timeout: 3000 },
    }));
  });
  it('fails closed without queuing rate-limit mutations while unavailable', async () => {
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
    create.mockReturnValue(client);
    await expect(new RedisService().incrementWindow('local-qa', 1000)).rejects.toThrow('Redis is not ready');
    expect(client.eval).not.toHaveBeenCalled();
  });
});
