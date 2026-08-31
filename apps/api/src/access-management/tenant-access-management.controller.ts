import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AccessManagementService } from './access-management.service';
import type { AccessActorContext } from './access-management.types';

@Controller('tenant/access')
export class TenantAccessManagementController {
  constructor(
    @Inject(AccessManagementService)
    private readonly access: AccessManagementService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('permissions')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'read',
    permissions: ['tenant.role.read'],
  })
  listPermissions() {
    return this.access.listPermissionDirectory('tenant');
  }

  @Get('roles')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'read',
    permissions: ['tenant.role.read'],
  })
  listRoles(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.access.listRoles(this.context(principal));
  }

  @Post('roles')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['tenant.role.manage'],
  })
  createRole(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.createRole(this.context(principal), input);
  }

  @Patch('roles/:roleId')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['tenant.role.manage'],
  })
  updateRole(
    @Param('roleId') roleId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.updateRole(this.context(principal), roleId, input);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['tenant.role.manage'],
  })
  replaceRolePermissions(
    @Param('roleId') roleId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.replaceRolePermissions(
      this.context(principal),
      roleId,
      input,
    );
  }

  @Put('staff/:staffId/roles/:roleId')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['tenant.staff.manage'],
  })
  assignStaffRole(
    @Param('staffId') staffId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.assignStaffRole(
      this.context(principal),
      staffId,
      roleId,
    );
  }

  @Delete('staff/:staffId/roles/:roleId')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['tenant.staff.manage'],
  })
  removeStaffRole(
    @Param('staffId') staffId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.removeStaffRole(
      this.context(principal),
      staffId,
      roleId,
    );
  }

  private context(principal: AccessPrincipal): AccessActorContext {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (
      !tenantId ||
      principal.scope !== 'tenant' ||
      principal.tenantId !== tenantId
    ) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return { actorId: principal.subjectId, scope: 'tenant', tenantId };
  }
}
