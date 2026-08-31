import { Inject, Injectable } from '@nestjs/common';

import type { AccessScope } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  renewSessionExpiryWindow,
  type SessionExpiryWindow,
} from './session-expiry';
import type {
  AuthenticationCredential,
  NewSessionRecord,
  RotatedSessionRecord,
  SessionRequestMetadata,
  StoredSessionPrincipal,
} from './authentication.types';

interface CredentialRow {
  id: string;
  login_name: string;
  mfa_enabled?: boolean;
  password_hash: string;
  status: 'active' | 'disabled' | 'locked';
  tenant_state?: 'active' | 'expired' | 'suspended';
}

interface SessionRow {
  absolute_expires_at: Date;
  access_expires_at: Date;
  database_now: Date;
  display_name: string;
  issued_at: Date;
  refresh_expires_at: Date;
  session_family_id: string;
  session_id: string;
  subject_id: string;
  tenant_state?: 'active' | 'expired' | 'suspended';
  version: number;
}

interface PermissionRow {
  permissions: string[];
}

@Injectable()
export class AuthenticationRepository {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async findCredential(
    scope: AccessScope,
    login: string,
    tenantId?: string,
  ): Promise<AuthenticationCredential | undefined> {
    return this.inScope(scope, tenantId, async (transaction) => {
      const rows = scope === 'platform'
        ? await transaction<CredentialRow[]>`
            select
              platform_staff.id,
              platform_staff.username::text as login_name,
              platform_staff.password_hash,
              platform_staff.status,
              platform_staff.mfa_enabled
            from platform_staff
            where username = ${login} or email = ${login} or phone = ${login}
            limit 1
          `
        : await transaction<CredentialRow[]>`
            select
              tenant_staff.id,
              tenant_staff.username::text as login_name,
              tenant_staff.password_hash,
              tenant_staff.status,
              false as mfa_enabled,
              case
                when tenant.status = 'active' and tenant.expires_at <= statement_timestamp()
                  then 'expired'
                else tenant.status
              end as tenant_state
            from tenant_staff
            inner join tenants as tenant on tenant.id = tenant_staff.tenant_id
            where tenant_staff.tenant_id = ${tenantId!}
              and (
                tenant_staff.username = ${login}
                or tenant_staff.email = ${login}
                or tenant_staff.phone = ${login}
              )
            limit 1
          `;

      const row = rows[0];
      return row
        ? {
            id: row.id,
            loginName: row.login_name,
            mfaEnabled: row.mfa_enabled ?? false,
            passwordHash: row.password_hash,
            status: row.status,
            tenantState: row.tenant_state,
          }
        : undefined;
    });
  }

  async recordLoginFailure(
    scope: AccessScope,
    loginHash: string,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<void> {
    await this.inScope(scope, tenantId, async (transaction) => {
      await transaction`
        insert into audit_logs (
          id,
          scope_type,
          tenant_id,
          actor_type,
          action,
          resource_type,
          after_json,
          ip,
          request_id
        ) values (
          ${uuidV7()},
          ${scope},
          ${tenantId ?? null},
          'system',
          'auth.login.failed',
          'auth_attempt',
          ${transaction.json({ loginHash })},
          ${metadata.ip ?? null},
          ${metadata.requestId}
        )
      `;
    });
  }

  async createSession(
    record: NewSessionRecord,
    metadata: SessionRequestMetadata,
  ): Promise<StoredSessionPrincipal> {
    return this.inScope(record.scope, record.tenantId, async (transaction) => {
      await transaction`
        insert into auth_sessions (
          id,
          session_family_id,
          tenant_id,
          subject_type,
          subject_id,
          access_token_hash,
          refresh_token_hash,
          issued_at,
          access_expires_at,
          refresh_expires_at,
          absolute_expires_at,
          last_seen_at,
          last_ip,
          user_agent_hash
        ) values (
          ${record.sessionId},
          ${record.sessionId},
          ${record.tenantId ?? null},
          ${record.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
          ${record.subjectId},
          ${record.accessTokenHash},
          ${record.refreshTokenHash},
          ${record.issuedAt},
          ${record.accessExpiresAt},
          ${record.refreshExpiresAt},
          ${record.absoluteExpiresAt},
          ${record.issuedAt},
          ${metadata.ip ?? null},
          ${metadata.userAgentHash ?? null}
        )
      `;

      const principal = await this.loadPrincipal(
        transaction,
        record.scope,
        record.sessionId,
        record.subjectId,
        record.tenantId,
      );
      if (!principal) {
        throw new Error('Authenticated principal could not be loaded');
      }

      await this.insertAudit(transaction, {
        action: 'auth.session.login',
        actorId: record.subjectId,
        actorType: record.scope === 'platform' ? 'platform_staff' : 'tenant_staff',
        metadata,
        resourceId: record.sessionId,
        scope: record.scope,
        tenantId: record.tenantId,
      });

      return principal;
    });
  }

  async findByAccessToken(
    scope: AccessScope,
    accessTokenHash: string,
    tenantId?: string,
  ): Promise<StoredSessionPrincipal | undefined> {
    return this.inScope(scope, tenantId, async (transaction) => {
      const rows = scope === 'platform'
        ? await transaction<SessionRow[]>`
            select
              session.id as session_id,
              session.session_family_id,
              session.subject_id,
              staff.username::text as display_name,
              session.issued_at,
              session.access_expires_at,
              session.refresh_expires_at,
              session.absolute_expires_at,
              session.version,
              statement_timestamp() as database_now
            from auth_sessions as session
            inner join platform_staff as staff on staff.id = session.subject_id
            where session.subject_type = 'platform_staff'
              and session.access_token_hash = ${accessTokenHash}
              and session.revoked_at is null
              and session.access_expires_at > statement_timestamp()
              and session.absolute_expires_at > statement_timestamp()
              and staff.status = 'active'
            limit 1
          `
        : await transaction<SessionRow[]>`
            select
              session.id as session_id,
              session.session_family_id,
              session.subject_id,
              staff.username::text as display_name,
              session.issued_at,
              session.access_expires_at,
              session.refresh_expires_at,
              session.absolute_expires_at,
              session.version,
              statement_timestamp() as database_now,
              case
                when tenant.status = 'active' and tenant.expires_at <= statement_timestamp()
                  then 'expired'
                else tenant.status
              end as tenant_state
            from auth_sessions as session
            inner join tenant_staff as staff
              on staff.id = session.subject_id and staff.tenant_id = session.tenant_id
            inner join tenants as tenant on tenant.id = session.tenant_id
            where session.subject_type = 'tenant_staff'
              and session.tenant_id = ${tenantId!}
              and session.access_token_hash = ${accessTokenHash}
              and session.revoked_at is null
              and session.access_expires_at > statement_timestamp()
              and session.absolute_expires_at > statement_timestamp()
              and staff.status = 'active'
            limit 1
          `;

      const session = rows[0];
      return session
        ? this.loadPrincipal(
            transaction,
            scope,
            session.session_id,
            session.subject_id,
            tenantId,
            session.display_name,
            session.tenant_state,
          )
        : undefined;
    });
  }

  async rotateSession(
    scope: AccessScope,
    refreshTokenHash: string,
    rotated: RotatedSessionRecord,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<StoredSessionPrincipal | undefined> {
    return this.inScope(scope, tenantId, async (transaction) => {
      const rows = scope === 'platform'
        ? await transaction<SessionRow[]>`
            select
              session.id as session_id,
              session.session_family_id,
              session.subject_id,
              staff.username::text as display_name,
              session.issued_at,
              session.access_expires_at,
              session.refresh_expires_at,
              session.absolute_expires_at,
              session.version,
              statement_timestamp() as database_now
            from auth_sessions as session
            inner join platform_staff as staff on staff.id = session.subject_id
            where session.subject_type = 'platform_staff'
              and session.refresh_token_hash = ${refreshTokenHash}
              and session.revoked_at is null
              and session.refresh_expires_at > statement_timestamp()
              and session.absolute_expires_at > statement_timestamp()
              and staff.status = 'active'
            for update of session
          `
        : await transaction<SessionRow[]>`
            select
              session.id as session_id,
              session.session_family_id,
              session.subject_id,
              staff.username::text as display_name,
              session.issued_at,
              session.access_expires_at,
              session.refresh_expires_at,
              session.absolute_expires_at,
              session.version,
              statement_timestamp() as database_now,
              case
                when tenant.status = 'active' and tenant.expires_at <= statement_timestamp()
                  then 'expired'
                else tenant.status
              end as tenant_state
            from auth_sessions as session
            inner join tenant_staff as staff
              on staff.id = session.subject_id and staff.tenant_id = session.tenant_id
            inner join tenants as tenant on tenant.id = session.tenant_id
            where session.subject_type = 'tenant_staff'
              and session.tenant_id = ${tenantId!}
              and session.refresh_token_hash = ${refreshTokenHash}
              and session.revoked_at is null
              and session.refresh_expires_at > statement_timestamp()
              and session.absolute_expires_at > statement_timestamp()
              and staff.status = 'active'
            for update of session
          `;

      const session = rows[0];
      if (!session) {
        await this.handleRefreshTokenReplay(
          transaction,
          scope,
          refreshTokenHash,
          metadata,
          tenantId,
        );
        return undefined;
      }

      const expiryWindow: SessionExpiryWindow = {
        absoluteExpiresAtMs: session.absolute_expires_at.getTime(),
        accessTokenExpiresAtMs: session.access_expires_at.getTime(),
        createdAtMs: session.issued_at.getTime(),
        refreshTokenExpiresAtMs: session.refresh_expires_at.getTime(),
      };
      const renewed = renewSessionExpiryWindow(
        expiryWindow,
        session.database_now.getTime(),
      );
      rotated.accessExpiresAt = new Date(renewed.accessTokenExpiresAtMs);
      rotated.refreshExpiresAt = new Date(renewed.refreshTokenExpiresAtMs);

      await transaction`
        insert into auth_refresh_token_history (
          id,
          tenant_id,
          session_id,
          session_family_id,
          subject_type,
          subject_id,
          token_hash,
          used_at,
          used_ip,
          used_user_agent_hash,
          expires_at
        ) values (
          ${uuidV7(session.database_now.getTime())},
          ${tenantId ?? null},
          ${session.session_id},
          ${session.session_family_id},
          ${scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
          ${session.subject_id},
          ${refreshTokenHash},
          ${session.database_now},
          ${metadata.ip ?? null},
          ${metadata.userAgentHash ?? null},
          ${session.absolute_expires_at}
        )
      `;

      const updated = await transaction<{ id: string }[]>`
        update auth_sessions
        set
          access_token_hash = ${rotated.accessTokenHash},
          refresh_token_hash = ${rotated.refreshTokenHash},
          access_expires_at = ${rotated.accessExpiresAt},
          refresh_expires_at = ${rotated.refreshExpiresAt},
          last_seen_at = statement_timestamp(),
          last_ip = ${metadata.ip ?? null},
          user_agent_hash = ${metadata.userAgentHash ?? null},
          version = version + 1
        where id = ${session.session_id} and version = ${session.version}
        returning id
      `;
      if (!updated[0]) {
        return undefined;
      }

      return this.loadPrincipal(
        transaction,
        scope,
        session.session_id,
        session.subject_id,
        tenantId,
        session.display_name,
        session.tenant_state,
      );
    });
  }

  async revokeByRefreshToken(
    scope: AccessScope,
    refreshTokenHash: string,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<void> {
    await this.inScope(scope, tenantId, async (transaction) => {
      const rows = await transaction<{ id: string; subject_id: string }[]>`
        update auth_sessions
        set
          revoked_at = statement_timestamp(),
          revoked_reason = 'logout',
          version = version + 1
        where refresh_token_hash = ${refreshTokenHash}
          and tenant_id is not distinct from ${tenantId ?? null}
          and revoked_at is null
        returning id, subject_id
      `;
      const row = rows[0];
      if (row) {
        await this.insertAudit(transaction, {
          action: 'auth.session.logout',
          actorId: row.subject_id,
          actorType: scope === 'platform' ? 'platform_staff' : 'tenant_staff',
          metadata,
          resourceId: row.id,
          scope,
          tenantId,
        });
      }
    });
  }

  private async loadPrincipal(
    transaction: DatabaseTransaction,
    scope: AccessScope,
    sessionId: string,
    subjectId: string,
    tenantId?: string,
    knownDisplayName?: string,
    knownTenantState?: 'active' | 'expired' | 'suspended',
  ): Promise<StoredSessionPrincipal | undefined> {
    const identityRows = knownDisplayName
      ? [{ display_name: knownDisplayName, tenant_state: knownTenantState }]
      : scope === 'platform'
        ? await transaction<{ display_name: string }[]>`
            select username::text as display_name
            from platform_staff
            where id = ${subjectId} and status = 'active'
          `
        : await transaction<
            { display_name: string; tenant_state: 'active' | 'expired' | 'suspended' }[]
          >`
            select
              staff.username::text as display_name,
              case
                when tenant.status = 'active' and tenant.expires_at <= statement_timestamp()
                  then 'expired'
                else tenant.status
              end as tenant_state
            from tenant_staff as staff
            inner join tenants as tenant on tenant.id = staff.tenant_id
            where staff.id = ${subjectId}
              and staff.tenant_id = ${tenantId!}
              and staff.status = 'active'
          `;
    const identity = identityRows[0];
    if (!identity) {
      return undefined;
    }

    const permissionRows = await transaction<PermissionRow[]>`
      select coalesce(
        array_agg(distinct permission.code::text)
          filter (where permission.id is not null),
        array[]::text[]
      ) as permissions
      from subject_roles as assignment
      inner join roles as role
        on role.id = assignment.role_id and role.status = 'active'
      inner join role_permissions as grant_record on grant_record.role_id = role.id
      inner join permissions as permission on permission.id = grant_record.permission_id
      where assignment.subject_id = ${subjectId}
        and assignment.scope_type = ${scope}
        and assignment.tenant_id is not distinct from ${tenantId ?? null}
        and grant_record.data_scope = 'all'
    `;

    return {
      displayName: identity.display_name,
      permissions: permissionRows[0]?.permissions ?? [],
      scope,
      sessionId,
      subjectId,
      tenantId,
      tenantState:
        'tenant_state' in identity ? identity.tenant_state : knownTenantState,
    };
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    input: {
      action: string;
      actorId: string;
      actorType: 'platform_staff' | 'tenant_staff';
      metadata: SessionRequestMetadata;
      resourceId: string;
      scope: AccessScope;
      tenantId?: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id,
        scope_type,
        tenant_id,
        actor_type,
        actor_id,
        action,
        resource_type,
        resource_id,
        ip,
        request_id
      ) values (
        ${uuidV7()},
        ${input.scope},
        ${input.tenantId ?? null},
        ${input.actorType},
        ${input.actorId},
        ${input.action},
        'auth_session',
        ${input.resourceId},
        ${input.metadata.ip ?? null},
        ${input.metadata.requestId}
      )
    `;
  }

  private async handleRefreshTokenReplay(
    transaction: DatabaseTransaction,
    scope: AccessScope,
    refreshTokenHash: string,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<void> {
    const rows = await transaction<
      {
        recent_same_client: boolean;
        session_family_id: string;
        session_id: string;
        subject_id: string;
      }[]
    >`
      select
        session_family_id,
        session_id,
        subject_id,
        used_at >= statement_timestamp() - interval '5 seconds'
          and used_ip is not distinct from ${metadata.ip ?? null}::inet
          and used_user_agent_hash is not distinct from ${metadata.userAgentHash ?? null}
          as recent_same_client
      from auth_refresh_token_history
      where token_hash = ${refreshTokenHash}
        and tenant_id is not distinct from ${tenantId ?? null}
        and expires_at > statement_timestamp()
      limit 1
      for update
    `;
    const replay = rows[0];
    if (!replay || replay.recent_same_client) {
      return;
    }

    await transaction`
      update auth_sessions
      set
        revoked_at = statement_timestamp(),
        revoked_reason = 'refresh_token_reuse',
        version = version + 1
      where session_family_id = ${replay.session_family_id}
        and revoked_at is null
    `;
    await this.insertAudit(transaction, {
      action: 'auth.refresh.reuse',
      actorId: replay.subject_id,
      actorType: scope === 'platform' ? 'platform_staff' : 'tenant_staff',
      metadata,
      resourceId: replay.session_id,
      scope,
      tenantId,
    });
  }

  private inScope<T>(
    scope: AccessScope,
    tenantId: string | undefined,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (scope === 'platform') {
      return this.database.inPlatformContext(callback);
    }
    if (!tenantId) {
      throw new TypeError('tenantId is required for tenant authentication');
    }
    return this.database.inTenantContext(tenantId, callback);
  }
}
