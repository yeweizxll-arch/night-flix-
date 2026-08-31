import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthenticationRepository } from '../src/auth/authentication.repository';
import type { RotatedSessionRecord } from '../src/auth/authentication.types';
import { digestToken, generateAccessToken, generateRefreshToken } from '../src/auth/token';
import { createSessionExpiryWindow } from '../src/auth/session-expiry';
import { uuidV7 } from '../src/common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../src/database/database.service';

let database: PGlite;
let repository: AuthenticationRepository;

const subjectId = '018f2f45-7f5e-7e70-b17f-f6e77357e001';
const roleId = '018f2f45-7f5e-7e70-b17f-f6e77357e002';
const permissionId = '018f2f45-7f5e-7e70-b17f-f6e77357e003';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  return (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    const result = await transaction.query(sql, values);
    return result.rows;
  }) as unknown as DatabaseTransaction;
}

describe('AuthenticationRepository PostgreSQL behavior', () => {
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
      insert into platform_staff (id, username, password_hash)
      values ('${subjectId}', 'repository-admin', '${'p'.repeat(64)}');
      insert into permissions (id, code, module, action)
      values ('${permissionId}', 'platform.dashboard.read', 'dashboard', 'read');
      insert into roles (id, scope_type, name, is_system)
      values ('${roleId}', 'platform', 'repository-admin-role', true);
      insert into role_permissions (
        role_id, permission_id, scope_type, data_scope
      ) values ('${roleId}', '${permissionId}', 'platform', 'all');
      insert into subject_roles (
        id, scope_type, subject_type, subject_id, role_id
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357e004',
        'platform',
        'platform_staff',
        '${subjectId}',
        '${roleId}'
      );
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        _tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    repository = new AuthenticationRepository(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('serializes concurrent rotation, archives once, and revokes on later replay', async () => {
    const nowMs = Date.now();
    const expiry = createSessionExpiryWindow(nowMs);
    const sessionId = uuidV7(nowMs);
    const access = generateAccessToken();
    const originalRefresh = generateRefreshToken();
    await repository.createSession(
      {
        absoluteExpiresAt: new Date(expiry.absoluteExpiresAtMs),
        accessExpiresAt: new Date(expiry.accessTokenExpiresAtMs),
        accessTokenHash: access.digest,
        issuedAt: new Date(nowMs),
        refreshExpiresAt: new Date(expiry.refreshTokenExpiresAtMs),
        refreshTokenHash: originalRefresh.digest,
        scope: 'platform',
        sessionId,
        subjectId,
      },
      { requestId: uuidV7() },
    );

    const firstAccess = generateAccessToken();
    const firstRefresh = generateRefreshToken();
    const secondAccess = generateAccessToken();
    const secondRefresh = generateRefreshToken();
    const firstRotation: RotatedSessionRecord = {
      accessExpiresAt: new Date(0),
      accessTokenHash: firstAccess.digest,
      refreshExpiresAt: new Date(0),
      refreshTokenHash: firstRefresh.digest,
    };
    const secondRotation: RotatedSessionRecord = {
      accessExpiresAt: new Date(0),
      accessTokenHash: secondAccess.digest,
      refreshExpiresAt: new Date(0),
      refreshTokenHash: secondRefresh.digest,
    };
    const sameClient = {
      ip: '203.0.113.50',
      requestId: uuidV7(),
      userAgentHash: `sha256$${'u'.repeat(43)}`,
    };

    const concurrent = await Promise.all([
      repository.rotateSession(
        'platform',
        originalRefresh.digest,
        firstRotation,
        sameClient,
      ),
      repository.rotateSession(
        'platform',
        originalRefresh.digest,
        secondRotation,
        { ...sameClient, requestId: uuidV7() },
      ),
    ]);

    expect(concurrent.filter(Boolean)).toHaveLength(1);
    const afterConcurrent = await database.query<{
      refresh_token_hash: string;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(`
      select refresh_token_hash, revoked_at, revoked_reason
      from auth_sessions where id = '${sessionId}'
    `);
    expect(afterConcurrent.rows[0]?.revoked_at).toBeNull();
    expect(afterConcurrent.rows[0]?.revoked_reason).toBeNull();
    expect([
      firstRefresh.digest,
      secondRefresh.digest,
    ]).toContain(afterConcurrent.rows[0]?.refresh_token_hash);

    const history = await database.query<{ count: string }>(`
      select count(*)::text as count
      from auth_refresh_token_history
      where session_id = '${sessionId}'
        and token_hash = '${digestToken(originalRefresh.token)}'
    `);
    expect(history.rows[0]?.count).toBe('1');

    await expect(
      repository.rotateSession(
        'platform',
        originalRefresh.digest,
        {
          accessExpiresAt: new Date(0),
          accessTokenHash: generateAccessToken().digest,
          refreshExpiresAt: new Date(0),
          refreshTokenHash: generateRefreshToken().digest,
        },
        {
          ip: '198.51.100.75',
          requestId: uuidV7(),
          userAgentHash: `sha256$${'v'.repeat(43)}`,
        },
      ),
    ).resolves.toBeUndefined();

    const revoked = await database.query<{
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(`
      select revoked_at, revoked_reason from auth_sessions where id = '${sessionId}'
    `);
    expect(revoked.rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect(revoked.rows[0]?.revoked_reason).toBe('refresh_token_reuse');

    const audits = await database.query<{ count: string }>(`
      select count(*)::text as count
      from audit_logs
      where resource_id = '${sessionId}' and action = 'auth.refresh.reuse'
    `);
    expect(audits.rows[0]?.count).toBe('1');
  });
});
