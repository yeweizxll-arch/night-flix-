import { afterEach, describe, expect, it, vi } from 'vitest';

import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { AuthenticationRepository } from './authentication.repository';
import type { RotatedSessionRecord } from './authentication.types';

interface RecordedQuery {
  sql: string;
  values: readonly unknown[];
}

type QueryHandler = (query: RecordedQuery) => Promise<unknown[]> | unknown[];

const databaseNow = new Date('2026-01-01T00:00:00.000Z');
const issuedAt = new Date('2025-12-20T00:00:00.000Z');
const absoluteExpiresAt = new Date('2026-01-19T00:00:00.000Z');
const sessionId = '018f2f45-7f5e-7e70-b17f-f6e77357d001';
const familyId = '018f2f45-7f5e-7e70-b17f-f6e77357d002';
const subjectId = '018f2f45-7f5e-7e70-b17f-f6e77357d003';
const oldRefreshHash = `sha256$${'a'.repeat(43)}`;

function compactSql(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

function createRepository(handler: QueryHandler): AuthenticationRepository {
  const transaction = (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => handler({ sql: compactSql(strings), values })) as unknown as DatabaseTransaction;
  const database = {
    inPlatformContext: <T>(
      callback: (current: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => callback(transaction),
    inTenantContext: <T>(
      _tenantId: string,
      callback: (current: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => callback(transaction),
  } as unknown as DatabaseService;
  return new AuthenticationRepository(database);
}

function currentSessionRow() {
  return {
    absolute_expires_at: absoluteExpiresAt,
    access_expires_at: new Date('2025-12-20T00:15:00.000Z'),
    database_now: databaseNow,
    display_name: 'root-admin',
    issued_at: issuedAt,
    refresh_expires_at: new Date('2026-01-10T00:00:00.000Z'),
    session_family_id: familyId,
    session_id: sessionId,
    subject_id: subjectId,
    version: 7,
  };
}

function newRotation(): RotatedSessionRecord {
  return {
    accessExpiresAt: new Date(0),
    accessTokenHash: `sha256$${'b'.repeat(43)}`,
    refreshExpiresAt: new Date(0),
    refreshTokenHash: `sha256$${'c'.repeat(43)}`,
  };
}

describe('AuthenticationRepository refresh rotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses database_now, archives the consumed token, and atomically replaces both tokens', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2099-01-01T00:00:00.000Z').getTime());
    const queries: RecordedQuery[] = [];
    const repository = createRepository((query) => {
      queries.push(query);
      if (query.sql.includes('from auth_sessions as session')) {
        return [currentSessionRow()];
      }
      if (query.sql.includes('update auth_sessions')) {
        return [{ id: sessionId }];
      }
      if (query.sql.includes('from subject_roles as assignment')) {
        return [{ permissions: ['platform.dashboard.read'] }];
      }
      return [];
    });
    const rotated = newRotation();

    const principal = await repository.rotateSession(
      'platform',
      oldRefreshHash,
      rotated,
      {
        ip: '203.0.113.10',
        requestId: '018f2f45-7f5e-7e70-b17f-f6e77357d004',
        userAgentHash: `sha256$${'d'.repeat(43)}`,
      },
    );

    expect(principal).toEqual(
      expect.objectContaining({ sessionId, subjectId, scope: 'platform' }),
    );
    expect(rotated.accessExpiresAt).toEqual(
      new Date('2026-01-01T00:15:00.000Z'),
    );
    expect(rotated.refreshExpiresAt).toEqual(
      new Date('2026-01-08T00:00:00.000Z'),
    );

    const historyIndex = queries.findIndex((query) =>
      query.sql.includes('insert into auth_refresh_token_history'),
    );
    const updateIndex = queries.findIndex((query) =>
      query.sql.includes('update auth_sessions'),
    );
    expect(historyIndex).toBeGreaterThan(0);
    expect(updateIndex).toBeGreaterThan(historyIndex);

    const history = queries[historyIndex];
    expect(history?.values).toEqual(
      expect.arrayContaining([
        sessionId,
        familyId,
        subjectId,
        oldRefreshHash,
        databaseNow,
        absoluteExpiresAt,
      ]),
    );
    const update = queries[updateIndex];
    expect(update?.values).toEqual(
      expect.arrayContaining([
        rotated.accessTokenHash,
        rotated.refreshTokenHash,
        rotated.accessExpiresAt,
        rotated.refreshExpiresAt,
        sessionId,
        7,
      ]),
    );
  });

  it('revokes the whole session family and writes an audit record for old-token replay', async () => {
    const queries: RecordedQuery[] = [];
    const repository = createRepository((query) => {
      queries.push(query);
      if (query.sql.includes('from auth_sessions as session')) {
        return [];
      }
      if (query.sql.includes('from auth_refresh_token_history')) {
        return [
          {
            recent_same_client: false,
            session_family_id: familyId,
            session_id: sessionId,
            subject_id: subjectId,
          },
        ];
      }
      return [];
    });

    await expect(
      repository.rotateSession(
        'platform',
        oldRefreshHash,
        newRotation(),
        {
          ip: '198.51.100.22',
          requestId: '018f2f45-7f5e-7e70-b17f-f6e77357d005',
          userAgentHash: `sha256$${'e'.repeat(43)}`,
        },
      ),
    ).resolves.toBeUndefined();

    const familyRevocation = queries.find(
      (query) =>
        query.sql.includes("revoked_reason = 'refresh_token_reuse'") &&
        query.sql.includes('where session_family_id ='),
    );
    expect(familyRevocation?.values).toContain(familyId);
    expect(
      queries.some(
        (query) =>
          query.sql.includes('insert into audit_logs') &&
          query.values.includes('auth.refresh.reuse'),
      ),
    ).toBe(true);
  });

  it('treats an immediate same-client duplicate as a failed retry without revoking', async () => {
    const queries: RecordedQuery[] = [];
    const repository = createRepository((query) => {
      queries.push(query);
      if (query.sql.includes('from auth_sessions as session')) {
        return [];
      }
      if (query.sql.includes('from auth_refresh_token_history')) {
        return [
          {
            recent_same_client: true,
            session_family_id: familyId,
            session_id: sessionId,
            subject_id: subjectId,
          },
        ];
      }
      return [];
    });

    await expect(
      repository.rotateSession(
        'platform',
        oldRefreshHash,
        newRotation(),
        {
          ip: '203.0.113.10',
          requestId: '018f2f45-7f5e-7e70-b17f-f6e77357d006',
          userAgentHash: `sha256$${'d'.repeat(43)}`,
        },
      ),
    ).resolves.toBeUndefined();

    expect(
      queries.some((query) => query.sql.includes('update auth_sessions')),
    ).toBe(false);
    expect(queries.some((query) => query.sql.includes('insert into audit_logs'))).toBe(
      false,
    );
  });
});
