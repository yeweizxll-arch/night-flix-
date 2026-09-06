import { Body, Controller, Get, Inject, Param, Put, Query, Post } from '@nestjs/common';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { RevenueShareService, type RevenueSharePolicyInput, type CashStatementInput, type AdStatementInput } from './revenue-share.service';

@Controller('platform/content-revenue')
export class PlatformContentRevenueController {
  constructor(@Inject(RevenueShareService) private readonly revenue: RevenueShareService) {}

  @Get('cash-status/:tenantId')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  cashStatus(@Param('tenantId') tenantId: string) { return this.revenue.cashStatus(tenantId); }

  @Get('sources/:tenantId')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  sources(@Param('tenantId') tenantId: string) { return this.revenue.sources(tenantId); }

  @Post('statements/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  statement(@Param('tenantId') tenantId: string, @Body() body: CashStatementInput, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.attachNetStatement(tenantId, body, { actorId: principal.subjectId, requestId: uuidV7() });
  }

  @Post('ad-statements/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  adStatement(@Param('tenantId') tenantId: string, @Body() body: AdStatementInput, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.importAdStatement(tenantId, body, { actorId: principal.subjectId, requestId: uuidV7() });
  }

  @Put('basis/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  basis(@Param('tenantId') tenantId: string, @Body() body: { basis: unknown }, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.configureBasis(tenantId, body?.basis, { actorId: principal.subjectId, requestId: uuidV7() });
  }

  @Post('legacy-review/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  legacyReview(@Param('tenantId') tenantId: string, @Body() body: { reportId: string; reportSha256: string }, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.acknowledgeLegacyReview(tenantId, body, { actorId: principal.subjectId, requestId: uuidV7() });
  }

  @Put('reconcile/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  reconcile(@Param('tenantId') tenantId: string, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.revenue.reconcile(tenantId, { actorId: principal.subjectId, requestId: uuidV7() });
  }

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
