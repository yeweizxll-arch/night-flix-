import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { RevenueShareService, type RevenueSharePolicyInput } from './revenue-share.service';

@Controller('platform/content-revenue')
export class PlatformContentRevenueController {
  constructor(@Inject(RevenueShareService) private readonly revenue: RevenueShareService) {}

  @Get('policies')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  policies(@Query() query: Record<string, unknown>) {
    return this.revenue.listPolicies(
      typeof query.tenantId === 'string' ? query.tenantId : undefined,
    );
  }

  @Put('policies/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  policy(@Param('tenantId') tenantId: string, @Body() input: RevenueSharePolicyInput,
    @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.upsertPolicy(tenantId, input, {
      actorId: principal.subjectId, requestId: uuidV7(),
    });
  }

  @Get('ledger')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  ledger(@Query() query: Record<string, unknown>) {
    return this.revenue.list(
      typeof query.tenantId === 'string' ? query.tenantId : undefined,
      typeof query.month === 'string' ? query.month : undefined,
    );
  }

  @Put('settlements/:tenantId/:month/:currency')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  settle(
    @Param('tenantId') tenantId: string,
    @Param('month') month: string,
    @Param('currency') currency: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.revenue.settleMonth(tenantId, month, currency, {
      actorId: principal.subjectId,
      requestId: uuidV7(),
    });
  }
}
