import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CryptoWorkLimiterService } from '../src/auth/crypto-work-limiter.service';
import { AuthenticationRepository } from '../src/auth/authentication.repository';
import { AuthenticationService } from '../src/auth/authentication.service';
import { verifyPassword } from '../src/auth/password';
import { generateAccessToken } from '../src/auth/token';
import { uuidV7 } from '../src/common/uuid-v7';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { StaffManagementService } from '../src/access-management/staff-management.service';
import type {
  StaffActorContext,
  StaffMutationMetadata,
} from '../src/access-management/staff-management.types';

let database: PGlite;
let staff: StaffManagementService;
let authentication: AuthenticationService;

const ids = {
  platformActor: '018f2f45-7f5e-7e70-b17f-f6e77357a001',
  platformRole: '018f2f45-7f5e-7e70-b17f-f6e77357a002',
  platformOperatorRole: '018f2f45-7f5e-7e70-b17f-f6e77357a003',
  platformOperator: '018f2f45-7f5e-7e70-b17f-f6e77357a016',
  tenantA: '018f2f45-7f5e-7e70-b17f-f6e77357a004',
  tenantB: '018f2f45-7f5e-7e70-b17f-f6e77357a005',
  tenantManager: '018f2f45-7f5e-7e70-b17f-f6e77357a006',
  tenantOwnerOne: '018f2f45-7f5e-7e70-b17f-f6e77357a007',
  tenantOwnerTwo: '018f2f45-7f5e-7e70-b17f-f6e77357a008',
  tenantBStaff: '018f2f45-7f5e-7e70-b17f-f6e77357a009',
  tenantOwnerRole: '018f2f45-7f5e-7e70-b17f-f6e77357a00a',
  tenantEditorRole: '018f2f45-7f5e-7e70-b17f-f6e77357a00b',
  tenantBOwnerRole: '018f2f45-7f5e-7e70-b17f-f6e77357a00c',
} as const;

const tenantContext: StaffActorContext = {
  actorId: ids.tenantManager,
  scope: 'tenant',
  tenantId: ids.tenantA,
};
const platformContext: StaffActorContext = {
  actorId: ids.platformActor,
  scope: 'platform',
};

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

function metadata(key?: string): StaffMutationMetadata {
  return {
    idempotencyKey: key,
    ip: '127.0.0.1',
    requestId: uuidV7(),
  };
}

describe('staff management PostgreSQL workflow', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${ids.tenantA}', 'staff-a', 'Staff A', statement_timestamp() + interval '1 year'),
        ('${ids.tenantB}', 'staff-b', 'Staff B', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash) values
        ('${ids.platformActor}', 'platform-root', '${'p'.repeat(64)}'),
        ('${ids.platformOperator}', 'platform-operator', '${'p'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash, email, phone) values
        ('${ids.tenantManager}', '${ids.tenantA}', 'staff-manager', '${'p'.repeat(64)}', 'manager@example.com', '+12025550101'),
        ('${ids.tenantOwnerOne}', '${ids.tenantA}', 'owner-one', '${'p'.repeat(64)}', null, null),
        ('${ids.tenantOwnerTwo}', '${ids.tenantA}', 'owner-two', '${'p'.repeat(64)}', null, null),
        ('${ids.tenantBStaff}', '${ids.tenantB}', 'owner-b', '${'p'.repeat(64)}', 'owner-b@example.com', '+12025550102');
      insert into roles (id, scope_type, tenant_id, name, status, is_system) values
        ('${ids.platformRole}', 'platform', null, 'platform_super_admin', 'active', true),
        ('${ids.platformOperatorRole}', 'platform', null, 'platform_operator', 'active', false),
        ('${ids.tenantOwnerRole}', 'tenant', '${ids.tenantA}', 'tenant_owner', 'active', true),
        ('${ids.tenantEditorRole}', 'tenant', '${ids.tenantA}', 'staff_editor', 'active', false),
        ('${ids.tenantBOwnerRole}', 'tenant', '${ids.tenantB}', 'tenant_owner', 'active', true);
      insert into subject_roles (id, scope_type, tenant_id, subject_type, subject_id, role_id) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357a011', 'platform', null, 'platform_staff', '${ids.platformActor}', '${ids.platformRole}'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357a017', 'platform', null, 'platform_staff', '${ids.platformOperator}', '${ids.platformOperatorRole}'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357a012', 'tenant', '${ids.tenantA}', 'tenant_staff', '${ids.tenantManager}', '${ids.tenantEditorRole}'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357a013', 'tenant', '${ids.tenantA}', 'tenant_staff', '${ids.tenantOwnerOne}', '${ids.tenantOwnerRole}'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357a014', 'tenant', '${ids.tenantA}', 'tenant_staff', '${ids.tenantOwnerTwo}', '${ids.tenantOwnerRole}'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357a015', 'tenant', '${ids.tenantB}', 'tenant_staff', '${ids.tenantBStaff}', '${ids.tenantBOwnerRole}');
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query("select set_config('app.access_scope', 'platform', true)");
        return callback(transactionTag(transaction));
      }),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [tenantId],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    staff = new StaffManagementService(databaseService, new CryptoWorkLimiterService());
    authentication = new AuthenticationService(new AuthenticationRepository(databaseService));
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('creates idempotently, assigns one role, masks contacts, and never leaks credentials', async () => {
    const input = {
      email: 'New.Staff@Example.COM',
      password: 'very-secure-password-001',
      phone: '+12025550123',
      roleId: ids.tenantEditorRole,
      username: 'New.Staff',
    };
    const created = await staff.create(
      tenantContext,
      input,
      metadata('staff-create-key-0001'),
    );
    const repeated = await staff.create(
      tenantContext,
      input,
      metadata('staff-create-key-0001'),
    );
    expect(repeated).toEqual(created);
    expect(created).toMatchObject({
      email: 'n***@example.com',
      phone: '+12****0123',
      roles: [{ id: ids.tenantEditorRole }],
      username: 'new.staff',
    });
    const serialized = JSON.stringify([created, repeated]);
    expect(serialized).not.toContain(input.password);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('password_hash');

    const stored = await database.query<{ password_hash: string }>(
      `select password_hash from tenant_staff where id = '${created.id}'`,
    );
    expect(stored.rows[0]?.password_hash).not.toContain(input.password);
    await expect(verifyPassword(input.password, stored.rows[0]!.password_hash)).resolves.toBe(true);

    const logs = await database.query<{ payload: unknown }>(`
      select after_json as payload from audit_logs where resource_id = '${created.id}'
      union all
      select payload_json as payload from outbox_events where aggregate_id = '${created.id}'
    `);
    expect(JSON.stringify(logs.rows)).not.toContain(input.password);
    expect(JSON.stringify(logs.rows)).not.toContain('password_hash');

    await expect(staff.create(
      tenantContext,
      { ...input, password: 'different-password-002' },
      metadata('staff-create-key-0001'),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(staff.create(
      tenantContext,
      { ...input, password: 'another-secure-password-004', username: 'other.staff' },
      metadata('staff-create-key-0002'),
    )).rejects.toThrow('already in use');
    await expect(staff.create(
      tenantContext,
      { ...input, tenantId: ids.tenantB },
      metadata('staff-create-key-0003'),
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates platform staff in the platform table without mixing tenant scope', async () => {
    const created = await staff.create(
      platformContext,
      {
        email: 'operator-two@example.com',
        password: 'platform-password-005',
        roleId: ids.platformOperatorRole,
        username: 'platform.operator.two',
      },
      { idempotencyKey: 'platform-staff-create-1', requestId: uuidV7() },
    );
    expect(created.roles).toEqual([
      expect.objectContaining({ id: ids.platformOperatorRole }),
    ]);
    const tenantRows = await database.query<{ count: string }>(`
      select count(*)::text as count from tenant_staff where id = '${created.id}'
    `);
    expect(tenantRows.rows[0]?.count).toBe('0');
  });

  it('keeps platform and tenants isolated and rejects tenantId injection', async () => {
    const platform = await staff.list(platformContext, {});
    expect(platform.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      ids.platformActor,
      ids.platformOperator,
    ]));
    const tenant = await staff.list(tenantContext, {});
    expect(tenant.items.some((item) => item.id === ids.tenantBStaff)).toBe(false);
    await expect(staff.detail(tenantContext, ids.tenantBStaff)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(() => staff.list(tenantContext, { tenantId: ids.tenantB })).toThrow(
      BadRequestException,
    );
  });

  it('resets passwords and revokes every active session without returning a hash', async () => {
    const target = (await staff.list(tenantContext, { q: 'new.staff' })).items[0]!;
    await insertSession(target.id, ids.tenantA, '018f2f45-7f5e-7e70-b17f-f6e77357a021');
    const reset = await staff.resetPassword(
      tenantContext,
      target.id,
      { password: 'replacement-password-003', version: target.version },
      metadata(),
    );
    expect(reset).toMatchObject({ id: target.id, sessionsRevoked: 1, version: 1 });
    expect(JSON.stringify(reset)).not.toContain('replacement-password-003');
    const stored = await database.query<{ password_hash: string }>(
      `select password_hash from tenant_staff where id = '${target.id}'`,
    );
    await expect(
      verifyPassword('replacement-password-003', stored.rows[0]!.password_hash),
    ).resolves.toBe(true);
    const sessions = await database.query<{ revoked_reason: string | null }>(`
      select revoked_reason from auth_sessions where subject_id = '${target.id}'
    `);
    expect(sessions.rows[0]?.revoked_reason).toBe('password_reset');
    const securityRecords = await database.query<{ payload: unknown }>(`
      select after_json as payload from audit_logs where resource_id = '${target.id}'
      union all
      select payload_json as payload from outbox_events where aggregate_id = '${target.id}'
    `);
    const securityJson = JSON.stringify(securityRecords.rows);
    expect(securityJson).not.toContain('replacement-password-003');
    expect(securityJson).not.toContain('password_hash');
    expect(securityJson).not.toContain('new.staff@example.com');
    expect(securityJson).not.toContain('+12025550123');
  });

  it('disables staff and invalidates their sessions in the same transaction', async () => {
    const target = (await staff.list(tenantContext, { q: 'new.staff' })).items[0]!;
    const accessToken = await insertSession(
      target.id,
      ids.tenantA,
      '018f2f45-7f5e-7e70-b17f-f6e77357a022',
    );
    await expect(authentication.authenticateAccess(accessToken, ids.tenantA)).resolves.toMatchObject({
      subjectId: target.id,
    });
    const disabled = await staff.updateStatus(
      tenantContext,
      target.id,
      { status: 'disabled', version: target.version },
      metadata(),
    );
    expect(disabled.status).toBe('disabled');
    const sessions = await database.query<{ count: string }>(`
      select count(*)::text as count from auth_sessions
      where subject_id = '${target.id}' and revoked_at is null
    `);
    expect(sessions.rows[0]?.count).toBe('0');
    await expect(authentication.authenticateAccess(accessToken, ids.tenantA)).rejects.toThrow(
      'Access token is invalid or expired',
    );
  });

  it('revokes sessions explicitly and protects the last platform super administrator', async () => {
    await insertSession(
      ids.tenantManager,
      ids.tenantA,
      '018f2f45-7f5e-7e70-b17f-f6e77357a023',
    );
    await expect(staff.revokeSessions(
      tenantContext,
      ids.tenantManager,
      { reason: 'security review' },
      metadata(),
    )).resolves.toMatchObject({ sessionsRevoked: 1 });

    const operatorContext: StaffActorContext = {
      actorId: ids.platformOperator,
      scope: 'platform',
    };
    await expect(staff.updateStatus(
      operatorContext,
      ids.platformActor,
      { status: 'disabled', version: 0 },
      { requestId: uuidV7() },
    )).rejects.toThrow('last active platform super administrator');
  });

  it('serializes last-owner protection so one active owner always remains', async () => {
    const results = await Promise.allSettled([
      staff.updateStatus(
        tenantContext,
        ids.tenantOwnerOne,
        { status: 'disabled', version: 0 },
        metadata(),
      ),
      staff.updateStatus(
        tenantContext,
        ids.tenantOwnerTwo,
        { status: 'disabled', version: 0 },
        metadata(),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const activeOwners = await database.query<{ count: string }>(`
      select count(distinct assignment.subject_id)::text as count
      from subject_roles as assignment
      inner join tenant_staff as staff on staff.id = assignment.subject_id
      where assignment.tenant_id = '${ids.tenantA}'
        and assignment.role_id = '${ids.tenantOwnerRole}'
        and staff.status = 'active'
    `);
    expect(activeOwners.rows[0]?.count).toBe('1');
  });

  it('serializes concurrent owner role changes so only one can drop ownership', async () => {
    await database.exec(`
      update tenant_staff set status = 'active'
      where id in ('${ids.tenantOwnerOne}', '${ids.tenantOwnerTwo}');
    `);
    const owners = await staff.list(tenantContext, { q: 'owner-' });
    const first = owners.items.find((item) => item.id === ids.tenantOwnerOne)!;
    const second = owners.items.find((item) => item.id === ids.tenantOwnerTwo)!;
    const results = await Promise.allSettled([
      staff.updateProfile(
        tenantContext,
        first.id,
        { roleId: ids.tenantEditorRole, version: first.version },
        metadata(),
      ),
      staff.updateProfile(
        tenantContext,
        second.id,
        { roleId: ids.tenantEditorRole, version: second.version },
        metadata(),
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const activeOwners = await database.query<{ count: string }>(`
      select count(distinct assignment.subject_id)::text as count
      from subject_roles as assignment
      inner join tenant_staff as staff on staff.id = assignment.subject_id
      where assignment.tenant_id = '${ids.tenantA}'
        and assignment.role_id = '${ids.tenantOwnerRole}'
        and staff.status = 'active'
    `);
    expect(activeOwners.rows[0]?.count).toBe('1');
  });
});

async function insertSession(subjectId: string, tenantId: string, sessionId: string) {
  const access = generateAccessToken();
  await database.exec(`
    insert into auth_sessions (
      id, session_family_id, tenant_id, subject_type, subject_id,
      access_token_hash, refresh_token_hash, issued_at,
      access_expires_at, refresh_expires_at, absolute_expires_at
    ) values (
      '${sessionId}', '${sessionId}', '${tenantId}', 'tenant_staff', '${subjectId}',
      '${access.digest}', '${`r${sessionId}`.padEnd(64, 'r')}',
      statement_timestamp(), statement_timestamp() + interval '15 minutes',
      statement_timestamp() + interval '1 day', statement_timestamp() + interval '7 days'
    )
  `);
  return access.token;
}
