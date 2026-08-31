import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
} from '@nestjs/common';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditService } from './audit.service';
import type { AuditLogQueryInput } from './audit.types';

@Controller('platform/audit-logs')
export class PlatformAuditController {
  constructor(
    @Inject(AuditService)
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.audit.read'],
    scope: 'platform',
  })
  list(@Query() query: AuditLogQueryInput) {
    return this.audit.listPlatform(query);
  }
}

@Controller('tenant/audit-logs')
export class TenantAuditController {
  constructor(
    @Inject(AuditService)
    private readonly audit: AuditService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.audit.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: AuditLogQueryInput,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    const verifiedTenantId = this.tenantContext.current()?.tenantId;
    if (
      principal.scope !== 'tenant'
      || !principal.tenantId
      || principal.tenantId !== verifiedTenantId
    ) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return this.audit.listTenant(principal.tenantId, query);
  }
}
