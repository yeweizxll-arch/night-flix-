import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import { AccessManagementService } from './access-management.service';
import type { AccessActorContext } from './access-management.types';

const IDS = {
  actor: '018f2f45-7f5e-7e70-b17f-f6e77357c001',
  otherTenant: '018f2f45-7f5e-7e70-b17f-f6e77357c002',
  role: '018f2f45-7f5e-7e70-b17f-f6e77357c003',
  staff: '018f2f45-7f5e-7e70-b17f-f6e77357c004',
  tenant: '018f2f45-7f5e-7e70-b17f-f6e77357c005',
} as const;

const platformContext: AccessActorContext = {
  actorId: IDS.actor,
  scope: 'platform',
};
const tenantContext: AccessActorContext = {
  actorId: IDS.actor,
  scope: 'tenant',
  tenantId: IDS.tenant,
};

describe('AccessManagementService', () => {
  it('returns a scope-filtered, read-only permission directory', () => {
    const { service } = createService();

    const platform = service.listPermissionDirectory('platform');
    const tenant = service.listPermissionDirectory('tenant');

    expect(platform).toContainEqual(
      expect.objectContaining({ code: 'platform.role.read', scope: 'platform' }),
    );
    expect(platform.some((item) => item.scope !== 'platform')).toBe(false);
    expect(platform.some((item) => ['platform.customer.manage', 'platform.customer.session_revoke'].includes(item.code))).toBe(false);
    expect(tenant).toContainEqual(
      expect.objectContaining({ code: 'tenant.role.read', scope: 'tenant' }),
    );
    expect(tenant.some((item) => item.scope !== 'tenant')).toBe(false);
  });

  it.each(['own', 'assigned']) (
    'rejects unsupported %s data scope before starting a transaction',
    async (dataScope) => {
      const { database, service } = createService();

      expect(() =>
        service.createRole(tenantContext, {
          name: 'Editor',
          permissions: [{ code: 'content.drama.read', dataScope }],
        }),
      ).toThrow(BadRequestException);
      expect(database.inTenantContext).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown and wrong-scope permission codes', async () => {
    const { database, service } = createService();

    expect(() =>
      service.createRole(tenantContext, {
        name: 'Editor',
        permissions: [{ code: 'unknown.permission.read', dataScope: 'all' }],
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      service.createRole(tenantContext, {
        name: 'Editor',
        permissions: [{ code: 'platform.role.read', dataScope: 'all' }],
      }),
    ).toThrow(BadRequestException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
    for (const code of ['platform.customer.manage', 'platform.customer.session_revoke']) {
      expect(() => service.createRole(platformContext, {
        name: 'Legacy operator', permissions: [{ code, dataScope: 'all' }],
      })).toThrow(BadRequestException);
    }
  });

  it('rejects tenantId supplied by the caller body', async () => {
    const { database, service } = createService();

    expect(() =>
      service.createRole(tenantContext, {
        name: 'Editor',
        permissions: [],
        tenantId: IDS.otherTenant,
      }),
    ).toThrow('tenantId cannot be supplied');
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });

  it('atomically replaces tenant grants inside the verified tenant transaction', async () => {
    const queries: QueryCall[] = [];
    const transaction = createTransaction(queries, (sql) => {
      if (sql.includes('from roles') && sql.includes('for update')) {
        return [{
          id: IDS.role,
          is_system: false,
          name: 'Editor',
          status: 'active',
          version: 3,
        }];
      }
      if (sql.includes('insert into role_permissions')) {
        return [{ id: IDS.role }];
      }
      if (sql.includes('update roles')) {
        return [{
          id: IDS.role,
          is_system: false,
          name: 'Editor',
          status: 'active',
          version: 4,
        }];
      }
      return [];
    });
    const { database, service } = createService(transaction);

    await expect(
      service.replaceRolePermissions(tenantContext, IDS.role, {
        permissions: [
          { code: 'content.drama.read', dataScope: 'all' },
          { code: 'content.drama.update', dataScope: 'all' },
        ],
        version: 3,
      }),
    ).resolves.toMatchObject({
      id: IDS.role,
      permissions: [
        { code: 'content.drama.read', dataScope: 'all' },
        { code: 'content.drama.update', dataScope: 'all' },
      ],
      version: 4,
    });

    expect(database.inTenantContext).toHaveBeenCalledWith(
      IDS.tenant,
      expect.any(Function),
    );
    expect(queries.map((query) => query.sql)).toEqual([
      expect.stringContaining('for update'),
      expect.stringContaining('delete from role_permissions'),
      expect.stringContaining('insert into role_permissions'),
      expect.stringContaining('insert into role_permissions'),
      expect.stringContaining('update roles'),
    ]);
    expect(queries.flatMap((query) => query.values)).not.toContain(
      IDS.otherTenant,
    );
  });

  it('treats a role outside the verified tenant as not found', async () => {
    const queries: QueryCall[] = [];
    const transaction = createTransaction(queries, () => []);
    const { database, service } = createService(transaction);

    await expect(
      service.replaceRolePermissions(tenantContext, IDS.role, {
        permissions: [],
        version: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(database.inTenantContext).toHaveBeenCalledWith(
      IDS.tenant,
      expect.any(Function),
    );
    expect(queries[0]?.values).toContain(IDS.tenant);
    expect(queries[0]?.values).not.toContain(IDS.otherTenant);
  });

  it('refuses to assign a tenant role to staff outside that tenant', async () => {
    const transaction = createTransaction([], (sql) => {
      if (sql.includes('select status') && sql.includes('from roles')) {
        return [{ status: 'active' }];
      }
      if (sql.includes('select exists')) {
        return [{ exists: false }];
      }
      return [];
    });
    const { service } = createService(transaction);

    await expect(
      service.assignStaffRole(tenantContext, IDS.staff, IDS.role),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the platform transaction for platform roles', async () => {
    const transaction = createTransaction([], (sql) => {
      if (sql.includes('from roles')) {
        return [];
      }
      return [];
    });
    const { database, service } = createService(transaction);

    await service.listRoles(platformContext);

    expect(database.inPlatformContext).toHaveBeenCalledOnce();
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });
});

interface QueryCall {
  sql: string;
  values: unknown[];
}

function createService(transaction?: DatabaseTransaction) {
  const fallbackTransaction = transaction ?? createTransaction([], () => []);
  const database = {
    inPlatformContext: vi.fn(
      async (callback: (value: DatabaseTransaction) => Promise<unknown>) =>
        callback(fallbackTransaction),
    ),
    inTenantContext: vi.fn(
      async (
        _tenantId: string,
        callback: (value: DatabaseTransaction) => Promise<unknown>,
      ) => callback(fallbackTransaction),
    ),
  };
  return {
    database,
    service: new AccessManagementService(
      database as unknown as DatabaseService,
    ),
  };
}

function createTransaction(
  calls: QueryCall[],
  resolve: (sql: string, values: unknown[]) => unknown,
): DatabaseTransaction {
  const transaction = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });
    return Promise.resolve(resolve(sql, values));
  };
  return transaction as unknown as DatabaseTransaction;
}
