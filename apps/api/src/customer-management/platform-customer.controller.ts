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
  RequirePermissions,
  type AccessPrincipal,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { CustomerManagementService } from './customer-management.service';
import type { CustomerActorContext } from './customer-management.types';

@Controller('platform/customers')
export class PlatformCustomerController {
  constructor(
    @Inject(CustomerManagementService)
    private readonly customers: CustomerManagementService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.customer.read'],
    scope: 'platform',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.customers.list(platformContext(principal), query);
  }

  @Get(':accountId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.customer.read'],
    scope: 'platform',
  })
  detail(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.customers.detail(
      platformContext(principal), platformTenantId(query), accountId,
    );
  }

  @Patch(':accountId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.customer.manage'],
    scope: 'platform',
  })
  updateStatus(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.customers.updateStatus(
      platformContext(principal), platformTenantId(query), accountId, input,
      customerMetadata(request),
    );
  }

  @Post(':accountId/revoke-sessions')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.customer.session_revoke'],
    scope: 'platform',
  })
  revokeSessions(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.customers.revokeSessions(
      platformContext(principal), platformTenantId(query), accountId, input,
      customerMetadata(request),
    );
  }
}

export function customerMetadata(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  return { idempotencyKey: value, ip: request.ip, requestId: uuidV7() };
}

function platformTenantId(query: Record<string, unknown>): unknown {
  if ('tenant_id' in query) throw new BadRequestException('tenant_id is not supported');
  return query.tenantId;
}

function platformContext(principal: AccessPrincipal): CustomerActorContext {
  if (principal.scope !== 'platform' || principal.tenantId !== undefined) {
    throw new ForbiddenException('Platform principal is required');
  }
  return { actorId: principal.subjectId, scope: 'platform' };
}
