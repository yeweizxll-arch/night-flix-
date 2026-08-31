import { ForbiddenException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService } from '../database/database.service';
import { PlatformHostPolicyService } from './platform-host-policy.service';

function fakeDatabase(
  resolverConfigured: boolean,
  tenantHosts: readonly string[] = [],
): { database: DatabaseService; resolverSql: ReturnType<typeof vi.fn> } {
  const resolverSql = vi.fn(
    async (_strings: TemplateStringsArray, host: string) =>
      tenantHosts.includes(host)
        ? [{ id: '018f2f45-7f5e-7e70-b17f-f6e77357f001' }]
        : [],
  );
  return {
    database: { resolverConfigured, resolverSql } as unknown as DatabaseService,
    resolverSql,
  };
}

describe('PlatformHostPolicyService', () => {
  afterEach(() => {
    delete process.env.PLATFORM_ADMIN_HOSTS;
    delete process.env.NODE_ENV;
  });

  it('allows only an explicitly configured administration host', () => {
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.com';
    const policy = new PlatformHostPolicyService(fakeDatabase(false).database);

    expect(() => policy.assertAllowed('ADMIN.EXAMPLE.COM:443')).not.toThrow();
    expect(() => policy.assertAllowed('merchant.example.com')).toThrow(
      ForbiddenException,
    );
  });

  it('requires an explicit host in production', () => {
    process.env.NODE_ENV = 'production';

    expect(
      () => new PlatformHostPolicyService(fakeDatabase(true).database),
    ).toThrow(
      /PLATFORM_ADMIN_HOSTS/,
    );
  });

  it('rejects production startup when any platform host resolves to a tenant', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.com, ops.example.com';
    const { database, resolverSql } = fakeDatabase(true, ['ops.example.com']);
    const policy = new PlatformHostPolicyService(database);

    await expect(policy.onModuleInit()).rejects.toThrow(
      /conflicts with a tenant domain: ops\.example\.com/,
    );
    expect(resolverSql).toHaveBeenCalledTimes(2);
  });

  it('allows production startup when platform hosts are absent from tenant resolution', async () => {
    process.env.NODE_ENV = 'production';
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.com,ADMIN.EXAMPLE.COM:443';
    const { database, resolverSql } = fakeDatabase(true);
    const policy = new PlatformHostPolicyService(database);

    await expect(policy.onModuleInit()).resolves.toBeUndefined();
    expect(resolverSql).toHaveBeenCalledTimes(1);
  });

  it('skips resolver validation outside production or without a resolver', async () => {
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.com';
    const development = fakeDatabase(true, ['admin.example.com']);
    await expect(
      new PlatformHostPolicyService(development.database).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(development.resolverSql).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'production';
    const withoutResolver = fakeDatabase(false, ['admin.example.com']);
    await expect(
      new PlatformHostPolicyService(withoutResolver.database).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(withoutResolver.resolverSql).not.toHaveBeenCalled();
  });
});
