import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import type { AccessManagementService } from './access-management.service';
import { PlatformAccessManagementController } from './platform-access-management.controller';
import { TenantAccessManagementController } from './tenant-access-management.controller';

const ACTOR_ID = '018f2f45-7f5e-7e70-b17f-f6e77357c001';
const TENANT_A = '018f2f45-7f5e-7e70-b17f-f6e77357c002';
const TENANT_B = '018f2f45-7f5e-7e70-b17f-f6e77357c003';

describe('access-management controller policies', () => {
  it.each([
    [PlatformAccessManagementController, 'listPermissions', 'platform', 'read', 'platform.role.read'],
    [PlatformAccessManagementController, 'listRoles', 'platform', 'read', 'platform.role.read'],
    [PlatformAccessManagementController, 'createRole', 'platform', 'write', 'platform.role.manage'],
    [PlatformAccessManagementController, 'updateRole', 'platform', 'write', 'platform.role.manage'],
    [PlatformAccessManagementController, 'replaceRolePermissions', 'platform', 'write', 'platform.role.manage'],
    [PlatformAccessManagementController, 'assignStaffRole', 'platform', 'write', 'platform.staff.manage'],
    [PlatformAccessManagementController, 'removeStaffRole', 'platform', 'write', 'platform.staff.manage'],
    [TenantAccessManagementController, 'listPermissions', 'tenant', 'read', 'tenant.role.read'],
    [TenantAccessManagementController, 'listRoles', 'tenant', 'read', 'tenant.role.read'],
    [TenantAccessManagementController, 'createRole', 'tenant', 'write', 'tenant.role.manage'],
    [TenantAccessManagementController, 'updateRole', 'tenant', 'write', 'tenant.role.manage'],
    [TenantAccessManagementController, 'replaceRolePermissions', 'tenant', 'write', 'tenant.role.manage'],
    [TenantAccessManagementController, 'assignStaffRole', 'tenant', 'write', 'tenant.staff.manage'],
    [TenantAccessManagementController, 'removeStaffRole', 'tenant', 'write', 'tenant.staff.manage'],
  ] as const)(
    '%s.%s requires the expected scope and permission',
    (controller, method, scope, mode, permission) => {
      const handler = controller.prototype[method] as (...args: never[]) => unknown;
      const requirement = Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA,
        handler,
      ) as AccessRequirement;

      expect(requirement).toEqual({
        mode,
        permissions: [permission],
        scope,
      });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('rejects a principal from a different tenant before calling the service', () => {
    const access = createAccessServiceMock();
    const tenantContext = {
      current: vi.fn().mockReturnValue({
        host: 'tenant-a.example.test',
        tenantId: TENANT_A,
        tenantStatus: 'active',
      }),
    };
    const controller = new TenantAccessManagementController(
      access as unknown as AccessManagementService,
      tenantContext as unknown as TenantContextService,
    );

    expect(() =>
      controller.createRole(
        { name: 'Editor', permissions: [] },
        tenantPrincipal(TENANT_B),
      ),
    ).toThrow(ForbiddenException);
    expect(access.createRole).not.toHaveBeenCalled();
  });

  it('uses the verified tenant context and never a body tenantId', () => {
    const access = createAccessServiceMock();
    const tenantContext = {
      current: vi.fn().mockReturnValue({
        host: 'tenant-a.example.test',
        tenantId: TENANT_A,
        tenantStatus: 'active',
      }),
    };
    const controller = new TenantAccessManagementController(
      access as unknown as AccessManagementService,
      tenantContext as unknown as TenantContextService,
    );
    const input = {
      name: 'Editor',
      permissions: [],
      tenantId: TENANT_B,
    };

    controller.createRole(input, tenantPrincipal(TENANT_A));

    expect(access.createRole).toHaveBeenCalledWith(
      { actorId: ACTOR_ID, scope: 'tenant', tenantId: TENANT_A },
      input,
    );
  });
});

function tenantPrincipal(tenantId: string): AccessPrincipal {
  return {
    permissions: ['tenant.role.manage'],
    scope: 'tenant',
    subjectId: ACTOR_ID,
    tenantId,
    tenantState: 'active',
  };
}

function createAccessServiceMock() {
  return {
    assignStaffRole: vi.fn(),
    createRole: vi.fn(),
    listPermissionDirectory: vi.fn(),
    listRoles: vi.fn(),
    removeStaffRole: vi.fn(),
    replaceRolePermissions: vi.fn(),
    updateRole: vi.fn(),
  };
}
