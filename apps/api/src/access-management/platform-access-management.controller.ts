import {
  Body,
  Controller,
  Delete,
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
import { AccessManagementService } from './access-management.service';
import type { AccessActorContext } from './access-management.types';

@Controller('platform/access')
export class PlatformAccessManagementController {
  constructor(
    @Inject(AccessManagementService)
    private readonly access: AccessManagementService,
  ) {}

  @Get('permissions')
  @RequirePermissions({
    scope: 'platform',
    mode: 'read',
    permissions: ['platform.role.read'],
  })
  listPermissions() {
    return this.access.listPermissionDirectory('platform');
  }

  @Get('roles')
  @RequirePermissions({
    scope: 'platform',
    mode: 'read',
    permissions: ['platform.role.read'],
  })
  listRoles(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.access.listRoles(platformContext(principal));
  }

  @Post('roles')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.role.manage'],
  })
  createRole(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.createRole(platformContext(principal), input);
  }

  @Patch('roles/:roleId')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.role.manage'],
  })
  updateRole(
    @Param('roleId') roleId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.updateRole(platformContext(principal), roleId, input);
  }

  @Put('roles/:roleId/permissions')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.role.manage'],
  })
  replaceRolePermissions(
    @Param('roleId') roleId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.replaceRolePermissions(
      platformContext(principal),
      roleId,
      input,
    );
  }

  @Put('staff/:staffId/roles/:roleId')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.staff.manage'],
  })
  assignStaffRole(
    @Param('staffId') staffId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.assignStaffRole(
      platformContext(principal),
      staffId,
      roleId,
    );
  }

  @Delete('staff/:staffId/roles/:roleId')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.staff.manage'],
  })
  removeStaffRole(
    @Param('staffId') staffId: string,
    @Param('roleId') roleId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.access.removeStaffRole(
      platformContext(principal),
      staffId,
      roleId,
    );
  }
}

function platformContext(principal: AccessPrincipal): AccessActorContext {
  return { actorId: principal.subjectId, scope: 'platform' };
}
