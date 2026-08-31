import { permissionCatalog } from '@drama/contracts';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AccessScope } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  AccessActorContext,
  PermissionDirectoryItem,
  RolePermissionGrant,
  RoleRecord,
  StaffRoleAssignmentResult,
} from './access-management.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const permissionByCode = new Map(
  permissionCatalog.map((permission) => [permission.code, permission]),
);

interface RoleRow {
  id: string;
  is_system: boolean;
  name: string;
  permissions: unknown;
  status: 'active' | 'disabled';
  version: number;
}

interface LockedRoleRow {
  id: string;
  is_system: boolean;
  name: string;
  status: 'active' | 'disabled';
  version: number;
}

@Injectable()
export class AccessManagementService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  listPermissionDirectory(scope: AccessScope): PermissionDirectoryItem[] {
    return permissionCatalog
      .filter((permission) => permission.scope === scope)
      .map((permission) => ({ ...permission }));
  }

  listRoles(context: AccessActorContext): Promise<RoleRecord[]> {
    assertContext(context);
    return this.inContext(context, async (transaction) => {
      const rows = await transaction<RoleRow[]>`
        select
          role.id,
          role.name::text,
          role.status,
          role.is_system,
          role.version,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'code', permission.code::text,
                'dataScope', grant_record.data_scope
              ) order by permission.code::text
            ) filter (where permission.id is not null),
            '[]'::jsonb
          ) as permissions
        from roles as role
        left join role_permissions as grant_record
          on grant_record.role_id = role.id
          and grant_record.scope_type = ${context.scope}
          and grant_record.tenant_id is not distinct from ${context.tenantId ?? null}
        left join permissions as permission on permission.id = grant_record.permission_id
        where role.scope_type = ${context.scope}
          and role.tenant_id is not distinct from ${context.tenantId ?? null}
        group by role.id
        order by role.is_system desc, role.name, role.id
      `;
      return rows.map(mapRoleRow);
    });
  }

  createRole(context: AccessActorContext, rawInput: unknown): Promise<RoleRecord> {
    assertContext(context);
    const input = parseCreateRoleInput(rawInput, context.scope);
    return this.inContext(context, async (transaction) => {
      try {
        const rows = await transaction<LockedRoleRow[]>`
          insert into roles (
            id,
            scope_type,
            tenant_id,
            name,
            status,
            is_system,
            created_by
          ) values (
            ${uuidV7()},
            ${context.scope},
            ${context.tenantId ?? null},
            ${input.name},
            'active',
            false,
            ${context.actorId}
          )
          returning id, name::text, status, is_system, version
        `;
        const role = rows[0];
        if (!role) {
          throw new Error('Role insert did not return a record');
        }
        await this.insertGrants(transaction, context, role.id, input.permissions);
        return mapLockedRole(role, input.permissions);
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('A role with this name already exists');
        }
        throw error;
      }
    });
  }

  updateRole(
    context: AccessActorContext,
    roleId: string,
    rawInput: unknown,
  ): Promise<RoleRecord> {
    assertContext(context);
    assertUuid(roleId, 'Role');
    const input = parseUpdateRoleInput(rawInput);
    return this.inContext(context, async (transaction) => {
      const current = await this.lockRole(transaction, context, roleId);
      assertMutableRole(current, input.version);
      try {
        const rows = await transaction<LockedRoleRow[]>`
          update roles
          set
            name = ${input.name ?? current.name},
            status = ${input.status ?? current.status},
            version = version + 1,
            updated_by = ${context.actorId}
          where id = ${current.id}
            and scope_type = ${context.scope}
            and tenant_id is not distinct from ${context.tenantId ?? null}
            and version = ${input.version}
          returning id, name::text, status, is_system, version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new ConflictException('Role was changed by another operator');
        }
        return mapLockedRole(
          updated,
          await this.loadRoleGrants(transaction, context, roleId),
        );
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('A role with this name already exists');
        }
        throw error;
      }
    });
  }

  replaceRolePermissions(
    context: AccessActorContext,
    roleId: string,
    rawInput: unknown,
  ): Promise<RoleRecord> {
    assertContext(context);
    assertUuid(roleId, 'Role');
    const input = parseReplacePermissionsInput(rawInput, context.scope);
    return this.inContext(context, async (transaction) => {
      const current = await this.lockRole(transaction, context, roleId);
      assertMutableRole(current, input.version);

      await transaction`
        delete from role_permissions
        where role_id = ${roleId}
          and scope_type = ${context.scope}
          and tenant_id is not distinct from ${context.tenantId ?? null}
      `;
      await this.insertGrants(transaction, context, roleId, input.permissions);
      const rows = await transaction<LockedRoleRow[]>`
        update roles
        set version = version + 1, updated_by = ${context.actorId}
        where id = ${roleId}
          and scope_type = ${context.scope}
          and tenant_id is not distinct from ${context.tenantId ?? null}
          and version = ${input.version}
        returning id, name::text, status, is_system, version
      `;
      const updated = rows[0];
      if (!updated) {
        throw new ConflictException('Role was changed by another operator');
      }
      return mapLockedRole(updated, input.permissions);
    });
  }

  assignStaffRole(
    context: AccessActorContext,
    staffId: string,
    roleId: string,
  ): Promise<StaffRoleAssignmentResult> {
    return this.changeStaffRole(context, staffId, roleId, true);
  }

  removeStaffRole(
    context: AccessActorContext,
    staffId: string,
    roleId: string,
  ): Promise<StaffRoleAssignmentResult> {
    return this.changeStaffRole(context, staffId, roleId, false);
  }

  private async changeStaffRole(
    context: AccessActorContext,
    staffId: string,
    roleId: string,
    assign: boolean,
  ): Promise<StaffRoleAssignmentResult> {
    assertContext(context);
    assertUuid(staffId, 'Staff member');
    assertUuid(roleId, 'Role');
    if (!assign && staffId === context.actorId) {
      throw new BadRequestException('You cannot remove your own role');
    }
    return this.inContext(context, async (transaction) => {
      await this.assertStaffAndRole(transaction, context, staffId, roleId, assign);
      if (!assign) {
        await this.assertProtectedRoleRemovalAllowed(
          transaction,
          context,
          staffId,
          roleId,
        );
      }
      if (assign) {
        await transaction`
          insert into subject_roles (
            id,
            scope_type,
            tenant_id,
            subject_type,
            subject_id,
            role_id,
            created_by
          ) values (
            ${uuidV7()},
            ${context.scope},
            ${context.tenantId ?? null},
            ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
            ${staffId},
            ${roleId},
            ${context.actorId}
          )
          on conflict do nothing
        `;
      } else {
        await transaction`
          delete from subject_roles
          where scope_type = ${context.scope}
            and tenant_id is not distinct from ${context.tenantId ?? null}
            and subject_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
            and subject_id = ${staffId}
            and role_id = ${roleId}
        `;
      }
      return { assigned: assign, roleId, staffId };
    });
  }

  private async assertProtectedRoleRemovalAllowed(
    transaction: DatabaseTransaction,
    context: AccessActorContext,
    staffId: string,
    roleId: string,
  ): Promise<void> {
    const protectedName = context.scope === 'platform'
      ? 'platform_super_admin'
      : 'tenant_owner';
    const rows = await transaction<Array<{ id: string }>>`
      select id from roles
      where id = ${roleId}
        and scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
        and name = ${protectedName}
        and is_system
      for update
    `;
    if (!rows[0]) return;
    const targetRows = context.scope === 'platform'
      ? await transaction<Array<{ status: string }>>`
          select status from platform_staff where id = ${staffId} for update
        `
      : await transaction<Array<{ status: string }>>`
          select status from tenant_staff
          where id = ${staffId} and tenant_id = ${context.tenantId!}
          for update
        `;
    if (targetRows[0]?.status !== 'active') return;
    const counts = context.scope === 'platform'
      ? await transaction<Array<{ total: string }>>`
          select count(distinct assignment.subject_id)::text as total
          from subject_roles as assignment
          inner join platform_staff as staff on staff.id = assignment.subject_id
          where assignment.scope_type = 'platform'
            and assignment.tenant_id is null
            and assignment.subject_type = 'platform_staff'
            and assignment.role_id = ${roleId}
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
            and assignment.role_id = ${roleId}
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

  private async assertStaffAndRole(
    transaction: DatabaseTransaction,
    context: AccessActorContext,
    staffId: string,
    roleId: string,
    requireActiveRole: boolean,
  ): Promise<void> {
    const roleRows = await transaction<{ status: 'active' | 'disabled' }[]>`
      select status
      from roles
      where id = ${roleId}
        and scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
      limit 1
    `;
    const role = roleRows[0];
    if (!role) {
      throw new NotFoundException('Role was not found');
    }
    if (requireActiveRole && role.status !== 'active') {
      throw new BadRequestException('A disabled role cannot be assigned');
    }

    const staffRows = context.scope === 'platform'
      ? await transaction<{ exists: boolean }[]>`
          select exists (
            select 1 from platform_staff where id = ${staffId}
          ) as exists
        `
      : await transaction<{ exists: boolean }[]>`
          select exists (
            select 1 from tenant_staff
            where id = ${staffId} and tenant_id = ${context.tenantId!}
          ) as exists
        `;
    if (!staffRows[0]?.exists) {
      throw new NotFoundException('Staff member was not found');
    }
  }

  private async lockRole(
    transaction: DatabaseTransaction,
    context: AccessActorContext,
    roleId: string,
  ): Promise<LockedRoleRow> {
    const rows = await transaction<LockedRoleRow[]>`
      select id, name::text, status, is_system, version
      from roles
      where id = ${roleId}
        and scope_type = ${context.scope}
        and tenant_id is not distinct from ${context.tenantId ?? null}
      for update
    `;
    const role = rows[0];
    if (!role) {
      throw new NotFoundException('Role was not found');
    }
    return role;
  }

  private async loadRoleGrants(
    transaction: DatabaseTransaction,
    context: AccessActorContext,
    roleId: string,
  ): Promise<RolePermissionGrant[]> {
    const rows = await transaction<{ code: string; data_scope: string }[]>`
      select permission.code::text as code, grant_record.data_scope
      from role_permissions as grant_record
      inner join permissions as permission on permission.id = grant_record.permission_id
      where grant_record.role_id = ${roleId}
        and grant_record.scope_type = ${context.scope}
        and grant_record.tenant_id is not distinct from ${context.tenantId ?? null}
      order by permission.code::text
    `;
    return rows.map((row) => mapStoredGrant(row.code, row.data_scope));
  }

  private async insertGrants(
    transaction: DatabaseTransaction,
    context: AccessActorContext,
    roleId: string,
    permissions: RolePermissionGrant[],
  ): Promise<void> {
    for (const permission of permissions) {
      const rows = await transaction<{ id: string }[]>`
        insert into role_permissions (
          role_id,
          permission_id,
          scope_type,
          tenant_id,
          data_scope,
          created_by
        )
        select
          ${roleId},
          permission.id,
          ${context.scope},
          ${context.tenantId ?? null},
          'all',
          ${context.actorId}
        from permissions as permission
        where permission.code = ${permission.code}
        returning permission_id as id
      `;
      if (!rows[0]) {
        throw new BadRequestException(
          `Permission ${permission.code} is not available`,
        );
      }
    }
  }

  private inContext<T>(
    context: AccessActorContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return context.scope === 'platform'
      ? this.database.inPlatformContext(callback)
      : this.database.inTenantContext(context.tenantId!, callback);
  }
}

function parseCreateRoleInput(
  raw: unknown,
  scope: AccessScope,
): { name: string; permissions: RolePermissionGrant[] } {
  const record = requireRecord(raw);
  rejectTenantId(record);
  return {
    name: parseRoleName(record.name),
    permissions: parseGrants(record.permissions ?? [], scope),
  };
}

function parseUpdateRoleInput(raw: unknown): {
  name?: string;
  status?: 'active' | 'disabled';
  version: number;
} {
  const record = requireRecord(raw);
  rejectTenantId(record);
  const version = parseVersion(record.version);
  const name = record.name === undefined ? undefined : parseRoleName(record.name);
  const status = record.status;
  if (
    status !== undefined &&
    status !== 'active' &&
    status !== 'disabled'
  ) {
    throw new BadRequestException('Role status must be active or disabled');
  }
  if (name === undefined && status === undefined) {
    throw new BadRequestException('At least one role field must change');
  }
  return { name, status, version };
}

function parseReplacePermissionsInput(
  raw: unknown,
  scope: AccessScope,
): { permissions: RolePermissionGrant[]; version: number } {
  const record = requireRecord(raw);
  rejectTenantId(record);
  return {
    permissions: parseGrants(record.permissions, scope),
    version: parseVersion(record.version),
  };
}

function parseGrants(value: unknown, scope: AccessScope): RolePermissionGrant[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('permissions must be an array');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const record = requireRecord(item);
    if (typeof record.code !== 'string') {
      throw new BadRequestException('Permission code is required');
    }
    const code = record.code.trim().toLowerCase();
    const dataScope = record.dataScope;
    if (dataScope === 'own' || dataScope === 'assigned') {
      throw new BadRequestException(
        `data_scope ${dataScope} is not supported; only all is allowed`,
      );
    }
    if (dataScope !== 'all') {
      throw new BadRequestException('data_scope must be all');
    }
    const catalogEntry = permissionByCode.get(code as never);
    if (!catalogEntry || catalogEntry.scope !== scope) {
      throw new BadRequestException(
        `Permission ${code || '(empty)'} is not allowed for ${scope} roles`,
      );
    }
    if (seen.has(code)) {
      throw new BadRequestException(`Permission ${code} is duplicated`);
    }
    seen.add(code);
    return { code, dataScope: 'all' };
  });
}

function mapRoleRow(row: RoleRow): RoleRecord {
  const permissions = Array.isArray(row.permissions)
    ? row.permissions.map((value) => {
        const record = requireRecord(value);
        return mapStoredGrant(record.code, record.dataScope);
      })
    : [];
  return {
    id: row.id,
    isSystem: row.is_system,
    name: row.name,
    permissions,
    status: row.status,
    version: row.version,
  };
}

function mapLockedRole(
  row: LockedRoleRow,
  permissions: RolePermissionGrant[],
): RoleRecord {
  return {
    id: row.id,
    isSystem: row.is_system,
    name: row.name,
    permissions,
    status: row.status,
    version: row.version,
  };
}

function mapStoredGrant(code: unknown, dataScope: unknown): RolePermissionGrant {
  if (typeof code !== 'string' || dataScope !== 'all') {
    throw new Error('Stored role permission is not supported');
  }
  return { code, dataScope };
}

function assertMutableRole(role: LockedRoleRow, version: number): void {
  if (role.is_system) {
    throw new BadRequestException('System roles cannot be modified');
  }
  if (role.version !== version) {
    throw new ConflictException('Role was changed by another operator');
  }
}

function assertContext(context: AccessActorContext): void {
  if (!UUID_PATTERN.test(context.actorId)) {
    throw new BadRequestException('Authenticated actor is invalid');
  }
  if (context.scope === 'platform') {
    if (context.tenantId !== undefined) {
      throw new BadRequestException('Platform access cannot include tenantId');
    }
    return;
  }
  if (!context.tenantId || !UUID_PATTERN.test(context.tenantId)) {
    throw new BadRequestException('A verified tenant context is required');
  }
}

function assertUuid(value: string, resource: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new NotFoundException(`${resource} was not found`);
  }
}

function parseRoleName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BadRequestException('Role name is required');
  }
  const name = value.trim();
  if (!name || name.length > 100) {
    throw new BadRequestException('Role name must contain 1 to 100 characters');
  }
  return name;
}

function parseVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException('A valid role version is required');
  }
  return value as number;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A valid request body is required');
  }
  return value as Record<string, unknown>;
}

function rejectTenantId(record: Record<string, unknown>): void {
  if ('tenantId' in record || 'tenant_id' in record) {
    throw new BadRequestException('tenantId cannot be supplied by the request body');
  }
}

function isDatabaseError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
