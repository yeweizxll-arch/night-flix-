import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import {
  CurrentPrincipal,
  RequirePermissions,
  type AccessPrincipal,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { FinanceService } from './finance.service';

@Controller('tenant/finance')
export class TenantFinanceController {
  constructor(
    @Inject(FinanceService)
    private readonly finance: FinanceService,
  ) {}

  @Get('balances')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.balance.read'], scope: 'tenant' })
  balances(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.finance.getTenantBalances(tenantId(principal));
  }

  @Get('ledger')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.balance.read'], scope: 'tenant' })
  ledger(
    @CurrentPrincipal() principal: AccessPrincipal,
    @Query() query: Record<string, unknown>,
  ) {
    return this.finance.listTenantLedger(tenantId(principal), query);
  }

  @Get('withdrawals')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.withdrawal.read'], scope: 'tenant' })
  withdrawals(
    @CurrentPrincipal() principal: AccessPrincipal,
    @Query() query: Record<string, unknown>,
  ) {
    return this.finance.listTenantWithdrawals(tenantId(principal), query);
  }

  @Get('withdrawals/:withdrawalId')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.withdrawal.read'], scope: 'tenant' })
  withdrawal(
    @Param('withdrawalId') withdrawalId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.getTenantWithdrawal(tenantId(principal), withdrawalId);
  }

  @Post('withdrawals')
  @RequirePermissions({ mode: 'write', permissions: ['commerce.withdrawal.submit'], scope: 'tenant' })
  submit(
    @Body() input: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.submitWithdrawal(
      tenantId(principal),
      principal.subjectId,
      input,
      singleHeader(idempotencyKey),
      uuidV7(),
    );
  }

  @Post('withdrawals/:withdrawalId/cancel')
  @RequirePermissions({ mode: 'write', permissions: ['commerce.withdrawal.submit'], scope: 'tenant' })
  cancel(
    @Param('withdrawalId') withdrawalId: string,
    @Body() input: { version?: unknown },
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.cancelWithdrawal(
      tenantId(principal),
      withdrawalId,
      principal.subjectId,
      input?.version,
      uuidV7(),
    );
  }
}

@Controller('platform/finance')
export class PlatformFinanceController {
  constructor(
    @Inject(FinanceService)
    private readonly finance: FinanceService,
  ) {}

  @Get('withdrawals')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  withdrawals(@Query() query: Record<string, unknown>) {
    return this.finance.listPlatformWithdrawals(query);
  }

  @Get('withdrawals/:withdrawalId')
  @RequirePermissions({ mode: 'read', permissions: ['finance.withdrawal.read'], scope: 'platform' })
  withdrawal(
    @Param('withdrawalId') withdrawalId: string,
  ) {
    return this.finance.getPlatformWithdrawal(withdrawalId);
  }

  @Get('withdrawals/:withdrawalId/payout-account')
  @RequirePermissions({
    mode: 'read',
    permissions: ['finance.withdrawal.payout_account.read'],
    scope: 'platform',
  })
  payoutAccount(
    @Param('withdrawalId') withdrawalId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.getPlatformPayoutAccount(
      withdrawalId,
      principal.subjectId,
      uuidV7(),
    );
  }

  @Post('withdrawals/:withdrawalId/review')
  @RequirePermissions({ mode: 'write', permissions: ['finance.withdrawal.review'], scope: 'platform' })
  review(
    @Param('withdrawalId') withdrawalId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.reviewWithdrawal(withdrawalId, principal.subjectId, input, uuidV7());
  }

  @Post('withdrawals/:withdrawalId/confirm-transfer')
  @RequirePermissions({
    mode: 'write',
    permissions: ['finance.withdrawal.confirm_transfer'],
    scope: 'platform',
  })
  confirmTransfer(
    @Param('withdrawalId') withdrawalId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.confirmTransfer(withdrawalId, principal.subjectId, input, uuidV7());
  }

  @Post('settlements/run')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  settle(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.settleDue(principal.subjectId, input, uuidV7());
  }

  @Put('settlements/policies/:tenantId')
  @RequirePermissions({ mode: 'write', permissions: ['finance.settlement.manage'], scope: 'platform' })
  policy(
    @Param('tenantId') selectedTenantId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.finance.upsertSettlementPolicy(
      selectedTenantId,
      principal.subjectId,
      input,
      uuidV7(),
    );
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  return value;
}
