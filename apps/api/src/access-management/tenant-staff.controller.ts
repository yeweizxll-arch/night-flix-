import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { rejectTenantQuery, staffMetadata } from './platform-staff.controller';
import { StaffManagementService } from './staff-management.service';
import type { StaffActorContext } from './staff-management.types';

@Controller('tenant/staff')
export class TenantStaffController {
  constructor(
    @Inject(StaffManagementService)
    private readonly staff: StaffManagementService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.staff.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.staff.list(this.context(principal), query);
  }

  @Get(':staffId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.staff.read'],
    scope: 'tenant',
  })
  detail(
    @Param('staffId') staffId: string,
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    rejectTenantQuery(query);
    return this.staff.detail(this.context(principal), staffId);
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.staff.manage'],
    scope: 'tenant',
  })
  create(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.create(
      this.context(principal), input, staffMetadata(request, true),
    );
  }

  @Patch(':staffId/profile')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.staff.manage'],
    scope: 'tenant',
  })
  updateProfile(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.updateProfile(
      this.context(principal), staffId, input, staffMetadata(request),
    );
  }

  @Patch(':staffId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.staff.manage'],
    scope: 'tenant',
  })
  updateStatus(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.updateStatus(
      this.context(principal), staffId, input, staffMetadata(request),
    );
  }

  @Post(':staffId/reset-password')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.staff.password_reset'],
    scope: 'tenant',
  })
  resetPassword(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.resetPassword(
      this.context(principal), staffId, input, staffMetadata(request),
    );
  }

  @Post(':staffId/revoke-sessions')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.staff.session_revoke'],
    scope: 'tenant',
  })
  revokeSessions(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.revokeSessions(
      this.context(principal), staffId, input, staffMetadata(request),
    );
  }

  private context(principal: AccessPrincipal): StaffActorContext {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId || principal.scope !== 'tenant' || principal.tenantId !== tenantId) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return { actorId: principal.subjectId, scope: 'tenant', tenantId };
  }
}
