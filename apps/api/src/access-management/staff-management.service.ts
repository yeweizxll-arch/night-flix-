import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AccessScope } from '../access-control';
import { CryptoWorkLimiterService } from '../auth/crypto-work-limiter.service';
import { hashPassword } from '../auth/password';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  StaffActorContext,
  StaffListResponse,
  StaffMutationMetadata,
  StaffRecord,
  StaffRoleSummary,
} from './staff-management.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

interface StaffRow {
  created_at: Date | string;
  email: string | null;
  id: string;
  password_hash?: string;
  phone: string | null;
  roles: unknown;
  status: 'active' | 'disabled' | 'locked';
  updated_at: Date | string;
  username: string;
  version: number;
}

interface LockedStaffRow extends StaffRow {
  roles: unknown;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

interface ParsedCreate {
  email?: string;
  password: string;
  passwordDigest: string;
  phone?: string;
  roleId: string;
  username: string;
}

interface ParsedProfile {
  email?: string | null;
  phone?: string | null;
  roleId?: string;
  username?: string;
  version: number;
}

@Injectable()
export class StaffManagementService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(CryptoWorkLimiterService)
    private readonly cryptoWorkLimiter: CryptoWorkLimiterService,
  ) {}

  list(
    context: StaffActorContext,
    rawQuery: Record<string, unknown>,
  ): Promise<StaffListResponse> {
    assertContext(context);
    const query = parseListQuery(rawQuery);
    return this.inContext(context, async (transaction) => {
      const search = query.q ? `%${escapeLike(query.q)}%` : undefined;
      const rows = context.scope === 'platform'
        ? await transaction<StaffRow[]>`
            select
              staff.id,
              staff.username::text,
              staff.email::text,
              staff.phone,
              staff.status,
              staff.version,
              staff.created_at,
              staff.updated_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', role.id, 'name', role.name::text,
                  'status', role.status, 'isSystem', role.is_system
                ) order by role.is_system desc, role.name::text, role.id)
                from subject_roles as assignment
                inner join roles as role on role.id = assignment.role_id
                where assignment.subject_id = staff.id
                  and assignment.subject_type = 'platform_staff'
                  and assignment.scope_type = 'platform'
                  and assignment.tenant_id is null
              ), '[]'::jsonb) as roles
            from platform_staff as staff
            where (${query.status ?? null}::text is null or staff.status = ${query.status ?? null})
              and (${search ?? null}::text is null or (
                staff.username::text ilike ${search ?? ''} escape '!'
              ))
            order by staff.created_at desc, staff.id desc
            limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
          `
        : await transaction<StaffRow[]>`
            select
              staff.id,
              staff.username::text,
              staff.email::text,
              staff.phone,
              staff.status,
              staff.version,
              staff.created_at,
              staff.updated_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', role.id, 'name', role.name::text,
                  'status', role.status, 'isSystem', role.is_system
                ) order by role.is_system desc, role.name::text, role.id)
                from subject_roles as assignment
                inner join roles as role on role.id = assignment.role_id
                where assignment.subject_id = staff.id
                  and assignment.subject_type = 'tenant_staff'
                  and assignment.scope_type = 'tenant'
                  and assignment.tenant_id = ${context.tenantId!}
              ), '[]'::jsonb) as roles
            from tenant_staff as staff
            where staff.tenant_id = ${context.tenantId!}
              and (${query.status ?? null}::text is null or staff.status = ${query.status ?? null})
              and (${search ?? null}::text is null or (
                staff.username::text ilike ${search ?? ''} escape '!'
              ))
            order by staff.created_at desc, staff.id desc
            limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
          `;
      const totals = context.scope === 'platform'
        ? await transaction<{ total: string }[]>`
            select count(*)::text as total
            from platform_staff as staff
            where (${query.status ?? null}::text is null or staff.status = ${query.status ?? null})
              and (${search ?? null}::text is null or (
                staff.username::text ilike ${search ?? ''} escape '!'
              ))
          `
        : await transaction<{ total: string }[]>`
            select count(*)::text as total
            from tenant_staff as staff
            where staff.tenant_id = ${context.tenantId!}
              and (${query.status ?? null}::text is null or staff.status = ${query.status ?? null})
              and (${search ?? null}::text is null or (
                staff.username::text ilike ${search ?? ''} escape '!'
              ))
          `;
      return {
        items: rows.map(mapStaff),
        page: query.page,
        pageSize: query.pageSize,
        total: Number(totals[0]?.total ?? 0),
      };
    });
  }

  detail(context: StaffActorContext, staffId: string): Promise<StaffRecord> {
    assertContext(context);
    assertUuid(staffId);
    return this.inContext(context, async (transaction) => {
      const row = await this.findStaff(transaction, context, staffId, false);
      if (!row) throw new NotFoundException('Staff member was not found');
      return mapStaff(row);
    });
  }

  async create(
    context: StaffActorContext,
    rawInput: unknown,
    metadata: StaffMutationMetadata,
  ): Promise<StaffRecord> {
    assertContext(context);
    const input = parseCreate(rawInput);
    const idempotencyKey = requireIdempotencyKey(metadata.idempotencyKey);
    const passwordHash = await this.cryptoWorkLimiter.run(() => hashPassword(input.password));
    return this.inContext(context, async (transaction) => {
      const command = await this.beginCommand<StaffRecord>(transaction, context, {
        actorId: context.actorId,
        idempotencyKey,
        request: {
          email: input.email ?? null,
          passwordDigest: input.passwordDigest,
          phone: input.phone ?? null,
          roleId: input.roleId,
          username: input.username,
        },
        routeKey: `${context.scope}.staff.create`,
      });
      if (command.cached) return command.cached;
      const role = await this.lockAssignableRole(transaction, context, input.roleId);
      const id = uuidV7();
      try {
        if (context.scope === 'platform') {
          await transaction`
            insert into platform_staff (
              id, username, email, phone, password_hash, created_by, updated_by
            ) values (
              ${id}, ${input.username}, ${input.email ?? null}, ${input.phone ?? null},
              ${passwordHash}, ${context.actorId}, ${context.actorId}
            )
          `;
        } else {
          await transaction`
            insert into tenant_staff (
              id, tenant_id, username, email, phone, password_hash, created_by, updated_by
            ) values (
              ${id}, ${context.tenantId!}, ${input.username}, ${input.email ?? null},
              ${input.phone ?? null}, ${passwordHash}, ${context.actorId}, ${context.actorId}
            )
          `;
        }
        await this.replaceAssignments(transaction, context, id, role.id);
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('Username, email, or phone is already in use');
        }
        throw error;
      }
      const created = await this.findStaff(transaction, context, id, false);
      if (!created) throw new Error('Created staff member could not be loaded');
      const response = mapStaff(created);
      await this.recordMutation(transaction, context, metadata, {
        action: `${context.scope}.staff.create`,
        after: safeAuditRecord(response),
        eventType: 'StaffCreated',
        resourceId: id,
      });
      await this.completeCommand(transaction, command.id, response, 201, id);
      return response;
    });
  }

  updateProfile(
    context: StaffActorContext,
    staffId: string,
    rawInput: unknown,
    metadata: StaffMutationMetadata,
  ): Promise<StaffRecord> {
    assertContext(context);
    assertUuid(staffId);
    const input = parseProfile(rawInput);
    if (staffId === context.actorId && input.roleId) {
      throw new ForbiddenException('You cannot change your own role');
    }
    return this.inContext(context, async (transaction) => {
      const protectedRole = await this.lockProtectedRole(transaction, context);
      const current = await this.requiredLockedStaff(transaction, context, staffId);
      assertVersion(current.version, input.version);
      let nextRole: StaffRoleSummary | undefined;
      if (input.roleId) {
        nextRole = await this.lockAssignableRole(transaction, context, input.roleId);
        await this.assertProtectedAssignmentPreserved(
          transaction,
          context,
          current,
          protectedRole.id,
          nextRole.id,
        );
      }
      try {
        const rows = context.scope === 'platform'
          ? await transaction<{ id: string }[]>`
              update platform_staff
              set
                username = ${input.username ?? current.username},
                email = ${input.email === undefined ? current.email : input.email},
                phone = ${input.phone === undefined ? current.phone : input.phone},
                version = version + 1,
                updated_by = ${context.actorId}
              where id = ${staffId} and version = ${input.version}
              returning id
            `
          : await transaction<{ id: string }[]>`
              update tenant_staff
              set
                username = ${input.username ?? current.username},
                email = ${input.email === undefined ? current.email : input.email},
                phone = ${input.phone === undefined ? current.phone : input.phone},
                version = version + 1,
                updated_by = ${context.actorId}
              where id = ${staffId} and tenant_id = ${context.tenantId!}
                and version = ${input.version}
              returning id
            `;
        if (!rows[0]) throw new ConflictException('Staff member was changed by another operator');
        if (nextRole) await this.replaceAssignments(transaction, context, staffId, nextRole.id);
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('Username, email, or phone is already in use');
        }
        throw error;
      }
      const updated = await this.findStaff(transaction, context, staffId, false);
      if (!updated) throw new Error('Updated staff member could not be loaded');
      const response = mapStaff(updated);
      await this.recordMutation(transaction, context, metadata, {
        action: `${context.scope}.staff.profile.update`,
        after: safeAuditRecord(response),
        before: safeAuditRecord(mapStaff(current)),
        eventType: 'StaffProfileChanged',
        resourceId: staffId,
      });
      return response;
    });
  }

  updateStatus(
    context: StaffActorContext,
    staffId: string,
    rawInput: unknown,
    metadata: StaffMutationMetadata,
  ): Promise<StaffRecord> {
    assertContext(context);
    assertUuid(staffId);
    const input = parseStatus(rawInput);
    if (staffId === context.actorId) {
      throw new ForbiddenException('You cannot change your own status');
    }
    return this.inContext(context, async (transaction) => {
      const protectedRole = await this.lockProtectedRole(transaction, context);
      const current = await this.requiredLockedStaff(transaction, context, staffId);
      assertVersion(current.version, input.version);
      if (current.status === 'active' && input.status !== 'active') {
        await this.assertProtectedAssignmentPreserved(
          transaction,
          context,
          current,
          protectedRole.id,
          undefined,
        );
      }
      const rows = context.scope === 'platform'
        ? await transaction<{ id: string }[]>`
            update platform_staff
            set status = ${input.status}, version = version + 1, updated_by = ${context.actorId}
            where id = ${staffId} and version = ${input.version}
            returning id
          `
        : await transaction<{ id: string }[]>`
            update tenant_staff
            set status = ${input.status}, version = version + 1, updated_by = ${context.actorId}
            where id = ${staffId} and tenant_id = ${context.tenantId!}
              and version = ${input.version}
            returning id
          `;
      if (!rows[0]) throw new ConflictException('Staff member was changed by another operator');
      if (input.status !== 'active') {
        await this.revokeAllSessions(transaction, context, staffId, 'staff_disabled');
      }
      const updated = await this.findStaff(transaction, context, staffId, false);
      if (!updated) throw new Error('Updated staff member could not be loaded');
      const response = mapStaff(updated);
      await this.recordMutation(transaction, context, metadata, {
        action: `${context.scope}.staff.status.update`,
        after: { status: response.status, version: response.version },
        before: { status: current.status, version: current.version },
        eventType: 'StaffStatusChanged',
        resourceId: staffId,
      });
      return response;
    });
  }

  async resetPassword(
    context: StaffActorContext,
    staffId: string,
    rawInput: unknown,
    metadata: StaffMutationMetadata,
  ): Promise<{ id: string; sessionsRevoked: number; version: number }> {
    assertContext(context);
    assertUuid(staffId);
    const input = parsePasswordReset(rawInput);
    const passwordHash = await this.cryptoWorkLimiter.run(() => hashPassword(input.password));
    return this.inContext(context, async (transaction) => {
      const current = await this.requiredLockedStaff(transaction, context, staffId);
      assertVersion(current.version, input.version);
      const rows = context.scope === 'platform'
        ? await transaction<Array<{ version: number }>>`
            update platform_staff
            set password_hash = ${passwordHash}, version = version + 1, updated_by = ${context.actorId}
            where id = ${staffId} and version = ${input.version}
            returning version
          `
        : await transaction<Array<{ version: number }>>`
            update tenant_staff
            set password_hash = ${passwordHash}, version = version + 1, updated_by = ${context.actorId}
            where id = ${staffId} and tenant_id = ${context.tenantId!}
              and version = ${input.version}
            returning version
          `;
      const version = rows[0]?.version;
      if (version === undefined) throw new ConflictException('Staff member was changed by another operator');
      const sessionsRevoked = await this.revokeAllSessions(
        transaction,
        context,
        staffId,
        'password_reset',
      );
      const response = { id: staffId, sessionsRevoked, version };
      await this.recordMutation(transaction, context, metadata, {
        action: `${context.scope}.staff.password.reset`,
        after: { credentialChanged: true, sessionsRevoked, version },
        eventType: 'StaffPasswordReset',
        resourceId: staffId,
      });
      return response;
    });
  }

  revokeSessions(
    context: StaffActorContext,
    staffId: string,
    rawInput: unknown,
    metadata: StaffMutationMetadata,
  ): Promise<{ id: string; sessionsRevoked: number }> {
    assertContext(context);
    assertUuid(staffId);
    const reason = parseRevokeSessions(rawInput);
    return this.inContext(context, async (transaction) => {
      const current = await this.findStaff(transaction, context, staffId, true);
      if (!current) throw new NotFoundException('Staff member was not found');
      const sessionsRevoked = await this.revokeAllSessions(
        transaction,
        context,
        staffId,
        `admin_revoke:${reason}`,
      );
      const response = { id: staffId, sessionsRevoked };
      await this.recordMutation(transaction, context, metadata, {
        action: `${context.scope}.staff.sessions.revoke`,
        after: { reason, sessionsRevoked },
        eventType: 'StaffSessionsRevoked',
        resourceId: staffId,
      });
      return response;
    });
  }

  private async findStaff(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staffId: string,
    lock: boolean,
  ): Promise<StaffRow | undefined> {
    const rows = context.scope === 'platform'
      ? lock
        ? await transaction<StaffRow[]>`
            select id, username::text, email::text, phone, status, version,
              created_at, updated_at, '[]'::jsonb as roles
            from platform_staff where id = ${staffId} for update
          `
        : await transaction<StaffRow[]>`
            select staff.id, staff.username::text, staff.email::text, staff.phone,
              staff.status, staff.version, staff.created_at, staff.updated_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', role.id, 'name', role.name::text,
                  'status', role.status, 'isSystem', role.is_system
                ) order by role.is_system desc, role.name::text, role.id)
                from subject_roles as assignment
                inner join roles as role on role.id = assignment.role_id
                where assignment.subject_id = staff.id
                  and assignment.subject_type = 'platform_staff'
                  and assignment.scope_type = 'platform'
                  and assignment.tenant_id is null
              ), '[]'::jsonb) as roles
            from platform_staff as staff where staff.id = ${staffId}
          `
      : lock
        ? await transaction<StaffRow[]>`
            select id, username::text, email::text, phone, status, version,
              created_at, updated_at, '[]'::jsonb as roles
            from tenant_staff where id = ${staffId} and tenant_id = ${context.tenantId!}
            for update
          `
        : await transaction<StaffRow[]>`
            select staff.id, staff.username::text, staff.email::text, staff.phone,
              staff.status, staff.version, staff.created_at, staff.updated_at,
              coalesce((
                select jsonb_agg(jsonb_build_object(
                  'id', role.id, 'name', role.name::text,
                  'status', role.status, 'isSystem', role.is_system
                ) order by role.is_system desc, role.name::text, role.id)
                from subject_roles as assignment
                inner join roles as role on role.id = assignment.role_id
                where assignment.subject_id = staff.id
                  and assignment.subject_type = 'tenant_staff'
                  and assignment.scope_type = 'tenant'
                  and assignment.tenant_id = ${context.tenantId!}
              ), '[]'::jsonb) as roles
            from tenant_staff as staff
            where staff.id = ${staffId} and staff.tenant_id = ${context.tenantId!}
          `;
    return rows[0];
  }

  private async requiredLockedStaff(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staffId: string,
  ): Promise<LockedStaffRow> {
    const row = await this.findStaff(transaction, context, staffId, true);
    if (!row) throw new NotFoundException('Staff member was not found');
    const roles = await this.loadRoles(transaction, context, staffId);
    return { ...row, roles };
  }

  private async loadRoles(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staffId: string,
  ): Promise<StaffRoleSummary[]> {
    const rows = await transaction<Array<{
      id: string;
      is_system: boolean;
      name: string;
      status: 'active' | 'disabled';
    }>>`
      select role.id, role.name::text, role.status, role.is_system
      from subject_roles as assignment
      inner join roles as role on role.id = assignment.role_id
      where assignment.subject_id = ${staffId}
        and assignment.subject_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
        and assignment.scope_type = ${context.scope}
        and assignment.tenant_id is not distinct from ${context.tenantId ?? null}
      order by role.is_system desc, role.name::text, role.id
    `;
    return rows.map((row) => ({
      id: row.id,
      isSystem: row.is_system,
      name: row.name,
      status: row.status,
    }));
  }

  private async lockAssignableRole(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    roleId: string,
  ): Promise<StaffRoleSummary> {
    const rows = await transaction<Array<{
      id: string;
      is_system: boolean;
      name: string;
      status: 'active' | 'disabled';
    }>>`
      select id, name::text, status, is_system
      from roles
      where id = ${roleId}
        and scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
      for update
    `;
    const role = rows[0];
    if (!role) throw new NotFoundException('Role was not found');
    if (role.status !== 'active') {
      throw new BadRequestException('A disabled role cannot be assigned');
    }
    return {
      id: role.id,
      isSystem: role.is_system,
      name: role.name,
      status: role.status,
    };
  }

  private async lockProtectedRole(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
  ): Promise<{ id: string }> {
    const name = context.scope === 'platform' ? 'platform_super_admin' : 'tenant_owner';
    const rows = await transaction<Array<{ id: string }>>`
      select id from roles
      where scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
        and name = ${name}
        and is_system
      for update
    `;
    if (!rows[0]) {
      throw new ConflictException(`Protected ${name} role is not configured`);
    }
    return rows[0];
  }

  private async assertProtectedAssignmentPreserved(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staff: LockedStaffRow,
    protectedRoleId: string,
    nextRoleId: string | undefined,
  ): Promise<void> {
    if (staff.status !== 'active' || nextRoleId === protectedRoleId) return;
    const roles = Array.isArray(staff.roles) ? staff.roles as StaffRoleSummary[] : [];
    if (!roles.some((role) => role.id === protectedRoleId)) return;
    const counts = context.scope === 'platform'
      ? await transaction<Array<{ total: string }>>`
          select count(distinct assignment.subject_id)::text as total
          from subject_roles as assignment
          inner join platform_staff as staff on staff.id = assignment.subject_id
          where assignment.scope_type = 'platform'
            and assignment.tenant_id is null
            and assignment.subject_type = 'platform_staff'
            and assignment.role_id = ${protectedRoleId}
            and staff.status = 'active'
        `
      : await transaction<Array<{ total: string }>>`
          select count(distinct assignment.subject_id)::text as total
          from subject_roles as assignment
          inner join tenant_staff as staff
            on staff.id = assignment.subject_id and staff.tenant_id = assignment.tenant_id
          where assignment.scope_type = 'tenant'
            and assignment.tenant_id = ${context.tenantId!}
            and assignment.subject_type = 'tenant_staff'
            and assignment.role_id = ${protectedRoleId}
            and staff.status = 'active'
        `;
    if (Number(counts[0]?.total ?? 0) <= 1) {
      throw new ConflictException(
        context.scope === 'platform'
          ? 'The last active platform super administrator must be retained'
          : 'The last active merchant owner must be retained',
      );
    }
  }

  private async replaceAssignments(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staffId: string,
    roleId: string,
  ): Promise<void> {
    await transaction`
      delete from subject_roles
      where scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
        and subject_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
        and subject_id = ${staffId}
    `;
    await transaction`
      insert into subject_roles (
        id, scope_type, tenant_id, subject_type, subject_id, role_id, created_by
      ) values (
        ${uuidV7()}, ${context.scope}, ${context.tenantId ?? null},
        ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
        ${staffId}, ${roleId}, ${context.actorId}
      )
    `;
  }

  private async revokeAllSessions(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    staffId: string,
    reason: string,
  ): Promise<number> {
    const rows = await transaction<Array<{ id: string }>>`
      update auth_sessions
      set revoked_at = statement_timestamp(), revoked_reason = ${reason}, version = version + 1
      where subject_id = ${staffId}
        and subject_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
        and tenant_id is not distinct from ${context.tenantId ?? null}
        and revoked_at is null
      returning id
    `;
    return rows.length;
  }

  private async recordMutation(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    metadata: StaffMutationMetadata,
    input: {
      action: string;
      after: object;
      before?: object;
      eventType: string;
      resourceId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, before_json, after_json, ip, request_id
      ) values (
        ${uuidV7()}, ${context.scope}, ${context.tenantId ?? null},
        ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
        ${context.actorId}, ${input.action}, 'staff_account', ${input.resourceId},
        ${input.before ? transaction.json(input.before as never) : null},
        ${transaction.json(input.after as never)}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, ${context.scope}, ${context.tenantId ?? null},
        ${`staff:${eventId}`}, ${`staff:${eventId}`}, 'staff_account',
        ${input.resourceId}, ${input.eventType},
        ${transaction.json(input.after as never)}
      )
    `;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    context: StaffActorContext,
    input: {
      actorId: string;
      idempotencyKey: string;
      request: unknown;
      routeKey: string;
    },
  ): Promise<{ cached?: T; id?: string }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input.request))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<Array<{ id: string }>>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, ${context.scope}, ${context.tenantId ?? null},
        ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
        ${input.actorId}, ${input.routeKey}, ${input.idempotencyKey}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select id, request_hash, status, response_json
      from command_idempotency
      where scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
        and actor_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
        and actor_id = ${input.actorId}
        and route_key = ${input.routeKey}
        and idempotency_key = ${input.idempotencyKey}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCommand(
    transaction: DatabaseTransaction,
    commandId: string | undefined,
    response: StaffRecord,
    responseStatus: number,
    resourceId: string,
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set status = 'completed', response_status = ${responseStatus},
        response_json = ${transaction.json(response as never)},
        resource_type = 'staff_account', resource_id = ${resourceId}, locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }

  private inContext<T>(
    context: StaffActorContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return context.scope === 'platform'
      ? this.database.inPlatformContext(callback)
      : this.database.inTenantContext(context.tenantId!, callback);
  }
}

function parseListQuery(raw: Record<string, unknown>) {
  rejectTenantId(raw);
  const page = integer(raw.page, 'page', 1, 1, 10_000);
  const pageSize = integer(raw.pageSize, 'pageSize', 20, 1, 100);
  const status = raw.status === undefined || raw.status === ''
    ? undefined
    : parseStaffStatus(raw.status, true);
  const q = raw.q === undefined || raw.q === ''
    ? undefined
    : requiredString(raw.q, 'q', 1, 100).toLowerCase();
  return { page, pageSize, q, status };
}

function parseCreate(raw: unknown): ParsedCreate {
  const record = body(raw);
  rejectTenantId(record);
  const password = parsePassword(record.password);
  return {
    email: optionalEmail(record.email),
    password,
    passwordDigest: createHash('sha256').update(password).digest('hex'),
    phone: optionalPhone(record.phone),
    roleId: requiredUuid(record.roleId, 'roleId'),
    username: parseUsername(record.username),
  };
}

function parseProfile(raw: unknown): ParsedProfile {
  const record = body(raw);
  rejectTenantId(record);
  const result: ParsedProfile = { version: version(record.version) };
  if ('username' in record) result.username = parseUsername(record.username);
  if ('email' in record) result.email = optionalEmail(record.email) ?? null;
  if ('phone' in record) result.phone = optionalPhone(record.phone) ?? null;
  if ('roleId' in record) result.roleId = requiredUuid(record.roleId, 'roleId');
  if (Object.keys(result).length === 1) {
    throw new BadRequestException('At least one profile field must change');
  }
  return result;
}

function parseStatus(raw: unknown): { status: 'active' | 'disabled'; version: number } {
  const record = body(raw);
  rejectTenantId(record);
  if (record.status !== 'active' && record.status !== 'disabled') {
    throw new BadRequestException('Staff status is invalid');
  }
  const status = record.status;
  return { status, version: version(record.version) };
}

function parsePasswordReset(raw: unknown): { password: string; version: number } {
  const record = body(raw);
  rejectTenantId(record);
  return { password: parsePassword(record.password), version: version(record.version) };
}

function parseRevokeSessions(raw: unknown): string {
  const record = body(raw);
  rejectTenantId(record);
  return requiredString(record.reason, 'reason', 1, 200);
}

function mapStaff(row: StaffRow): StaffRecord {
  const roles = Array.isArray(row.roles)
    ? row.roles.map((value) => {
        const role = body(value);
        return {
          id: String(role.id),
          isSystem: role.isSystem === true,
          name: String(role.name),
          status: role.status === 'disabled' ? 'disabled' as const : 'active' as const,
        };
      })
    : [];
  return {
    createdAt: iso(row.created_at),
    email: row.email ? maskEmail(row.email) : undefined,
    id: row.id,
    phone: row.phone ? maskPhone(row.phone) : undefined,
    roles,
    status: row.status,
    updatedAt: iso(row.updated_at),
    username: row.username,
    version: row.version,
  };
}

function safeAuditRecord(record: StaffRecord) {
  return {
    email: record.email ?? null,
    id: record.id,
    phone: record.phone ?? null,
    roleIds: record.roles.map((role) => role.id),
    status: record.status,
    username: record.username,
    version: record.version,
  };
}

function assertContext(context: StaffActorContext): void {
  if (!UUID_PATTERN.test(context.actorId)) {
    throw new BadRequestException('Authenticated actor is invalid');
  }
  if (context.scope === 'platform') {
    if (context.tenantId !== undefined) {
      throw new BadRequestException('Platform context cannot include tenantId');
    }
    return;
  }
  if (!context.tenantId || !UUID_PATTERN.test(context.tenantId)) {
    throw new BadRequestException('A verified tenant context is required');
  }
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new NotFoundException('Staff member was not found');
}

function requiredUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value;
}

function parseUsername(value: unknown): string {
  const username = requiredString(value, 'username', 3, 64).toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new BadRequestException('Username format is invalid');
  }
  return username;
}

function optionalEmail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const email = requiredString(value, 'email', 3, 320).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new BadRequestException('Email format is invalid');
  return email;
}

function optionalPhone(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const phone = requiredString(value, 'phone', 8, 16);
  if (!PHONE_PATTERN.test(phone)) throw new BadRequestException('Phone must use E.164 format');
  return phone;
}

function parsePassword(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('Password is required');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < 12 || bytes > 4_096) {
    throw new BadRequestException('Password must contain 12 to 4096 UTF-8 bytes');
  }
  return value;
}

function parseStaffStatus(value: unknown, allowLocked: boolean) {
  if (value === 'active' || value === 'disabled' || (allowLocked && value === 'locked')) {
    return value;
  }
  throw new BadRequestException('Staff status is invalid');
}

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException('A valid staff version is required');
  }
  return value as number;
}

function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new ConflictException('Staff member was changed by another operator');
}

function requiredString(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new BadRequestException(`${name} length is invalid`);
  }
  return normalized;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A valid request body is required');
  }
  return value as Record<string, unknown>;
}

function rejectTenantId(record: Record<string, unknown>): void {
  if ('tenantId' in record || 'tenant_id' in record) {
    throw new BadRequestException('tenantId cannot be supplied by the request');
  }
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new BadRequestException('A single valid Idempotency-Key is required');
  }
  return key;
}

function integer(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  if (at <= 0) return '***';
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

function maskPhone(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function isDatabaseError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === code;
}
