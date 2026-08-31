import {
  BadRequestException,
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
import { uuidV7 } from '../common/uuid-v7';
import { StaffManagementService } from './staff-management.service';
import type { StaffActorContext } from './staff-management.types';

@Controller('platform/staff')
export class PlatformStaffController {
  constructor(
    @Inject(StaffManagementService)
    private readonly staff: StaffManagementService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.staff.read'],
    scope: 'platform',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.staff.list(platformContext(principal), query);
  }

  @Get(':staffId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.staff.read'],
    scope: 'platform',
  })
  detail(
    @Param('staffId') staffId: string,
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    rejectTenantQuery(query);
    return this.staff.detail(platformContext(principal), staffId);
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.staff.manage'],
    scope: 'platform',
  })
  create(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.create(
      platformContext(principal),
      input,
      metadata(request, true),
    );
  }

  @Patch(':staffId/profile')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.staff.manage'],
    scope: 'platform',
  })
  updateProfile(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.updateProfile(
      platformContext(principal), staffId, input, metadata(request),
    );
  }

  @Patch(':staffId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.staff.manage'],
    scope: 'platform',
  })
  updateStatus(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.updateStatus(
      platformContext(principal), staffId, input, metadata(request),
    );
  }

  @Post(':staffId/reset-password')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.staff.password_reset'],
    scope: 'platform',
  })
  resetPassword(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.resetPassword(
      platformContext(principal), staffId, input, metadata(request),
    );
  }

  @Post(':staffId/revoke-sessions')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.staff.session_revoke'],
    scope: 'platform',
  })
  revokeSessions(
    @Param('staffId') staffId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.staff.revokeSessions(
      platformContext(principal), staffId, input, metadata(request),
    );
  }
}

export function staffMetadata(request: FastifyRequest, requireKey = false) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BadRequestException('Idempotency-Key header is ambiguous');
    }
  }
  const idempotencyKey = Array.isArray(value) ? value[0] : value;
  if (requireKey && typeof idempotencyKey !== 'string') {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  return {
    idempotencyKey,
    ip: request.ip,
    requestId: uuidV7(),
  };
}

export function rejectTenantQuery(query: Record<string, unknown>): void {
  if ('tenantId' in query || 'tenant_id' in query) {
    throw new BadRequestException('tenantId cannot be supplied by the request');
  }
}

function metadata(request: FastifyRequest, requireKey = false) {
  return staffMetadata(request, requireKey);
}

function platformContext(principal: AccessPrincipal): StaffActorContext {
  if (principal.scope !== 'platform' || principal.tenantId !== undefined) {
    throw new ForbiddenException('Platform principal is required');
  }
  return { actorId: principal.subjectId, scope: 'platform' };
}

