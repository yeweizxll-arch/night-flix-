import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { RevenueShareService, type RevenueSharePolicyInput } from './revenue-share.service';

@Controller('platform/content-revenue')
export class PlatformContentRevenueController {
  constructor(@Inject(RevenueShareService) private readonly revenue: RevenueShareService) {}

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
}
