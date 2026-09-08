import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service';

const create = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('postgres', () => ({ default: create }));

afterEach(() => { vi.unstubAllEnvs(); create.mockClear(); });
describe('database concurrency safety configuration', () => {
  it('bounds query and lock waits on every connection', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://local/test');
    vi.stubEnv('PLATFORM_DATABASE_URL', 'postgres://platform/test');
    vi.stubEnv('TENANT_RESOLVER_DATABASE_URL', 'postgres://resolver/test');
    new DatabaseService();
    expect(create).toHaveBeenCalledTimes(3);
    for (const call of create.mock.calls as unknown as Array<[string, unknown]>) {
      expect(call[1]).toMatchObject({ max: 10, connection: { statement_timeout: 30000, lock_timeout: 5000 } });
    }
  });
  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '1001'])('rejects invalid pool size %s at startup', value => {
    vi.stubEnv('DATABASE_URL', 'postgres://local/test');
    vi.stubEnv('DATABASE_POOL_MAX', value);
    expect(() => new DatabaseService()).toThrow('DATABASE_POOL_MAX');
  });
});
