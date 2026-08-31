import { Controller, ForbiddenException, Get, Inject, Query } from '@nestjs/common';

import {
  CurrentPrincipal,
  RequirePermissions,
  type AccessPrincipal,
} from '../access-control';
import { AnalyticsService } from './analytics.service';

@Controller('platform/analytics')
export class PlatformAnalyticsController {
  constructor(
    @Inject(AnalyticsService)
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('overview')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.analytics.read'],
    scope: 'platform',
  })
  overview(@Query() query: Record<string, unknown>) {
    return this.analytics.getPlatformOverview(query);
  }

  @Get('tenants')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.analytics.read'],
    scope: 'platform',
  })
  tenants(@Query() query: Record<string, unknown>) {
    return this.analytics.getPlatformTenantRanking(query);
  }
}

@Controller('tenant/analytics')
export class TenantAnalyticsController {
  constructor(
    @Inject(AnalyticsService)
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('overview')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.analytics.read'],
    scope: 'tenant',
  })
  overview(
    @CurrentPrincipal() principal: AccessPrincipal,
    @Query() query: Record<string, unknown>,
  ) {
    return this.analytics.getTenantOverview(requireTenantId(principal), query);
  }
}

function requireTenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new ForbiddenException('Tenant principal was not established');
  }
  return principal.tenantId;
}
