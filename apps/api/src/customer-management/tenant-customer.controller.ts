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
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerManagementService } from './customer-management.service';
import type { CustomerActorContext } from './customer-management.types';
import { customerMetadata } from './platform-customer.controller';

@Controller('tenant/customers')
export class TenantCustomerController {
  constructor(
    @Inject(CustomerManagementService)
    private readonly customers: CustomerManagementService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.customer.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.customers.list(this.context(principal), query);
  }

  @Get(':accountId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.customer.read'],
    scope: 'tenant',
  })
  detail(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    rejectTenantQuery(query);
    return this.customers.detail(this.context(principal), undefined, accountId);
  }

  @Patch(':accountId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.customer.manage'],
    scope: 'tenant',
  })
  updateStatus(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    rejectTenantQuery(query);
    return this.customers.updateStatus(
      this.context(principal), undefined, accountId, input, customerMetadata(request),
    );
  }

  @Post(':accountId/revoke-sessions')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.customer.session_revoke'],
    scope: 'tenant',
  })
  revokeSessions(
    @Param('accountId') accountId: string,
    @Query() query: Record<string, unknown>,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    rejectTenantQuery(query);
    return this.customers.revokeSessions(
      this.context(principal), undefined, accountId, input, customerMetadata(request),
    );
  }

  private context(principal: AccessPrincipal): CustomerActorContext {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId || principal.scope !== 'tenant' || principal.tenantId !== tenantId) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return { actorId: principal.subjectId, scope: 'tenant', tenantId };
  }
}

function rejectTenantQuery(query: Record<string, unknown>): void {
  if ('tenantId' in query || 'tenant_id' in query) {
    throw new BadRequestException('tenantId cannot be supplied by tenant requests');
  }
}
