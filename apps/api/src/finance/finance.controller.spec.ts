import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformFinanceController,
  TenantFinanceController,
} from './finance.controller';
import type { FinanceService } from './finance.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const withdrawalId = '33333333-3333-4333-8333-333333333333';

describe('finance controller security metadata', () => {
  it.each([
    [TenantFinanceController, 'balances', 'read', 'commerce.balance.read', 'tenant'],
    [TenantFinanceController, 'ledger', 'read', 'commerce.balance.read', 'tenant'],
    [TenantFinanceController, 'withdrawals', 'read', 'commerce.withdrawal.read', 'tenant'],
    [TenantFinanceController, 'withdrawal', 'read', 'commerce.withdrawal.read', 'tenant'],
    [TenantFinanceController, 'submit', 'write', 'commerce.withdrawal.submit', 'tenant'],
    [TenantFinanceController, 'cancel', 'write', 'commerce.withdrawal.submit', 'tenant'],
    [PlatformFinanceController, 'withdrawals', 'read', 'finance.withdrawal.read', 'platform'],
    [PlatformFinanceController, 'withdrawal', 'read', 'finance.withdrawal.read', 'platform'],
    [
      PlatformFinanceController,
      'payoutAccount',
      'read',
      'finance.withdrawal.payout_account.read',
      'platform',
    ],
    [PlatformFinanceController, 'review', 'write', 'finance.withdrawal.review', 'platform'],
    [
      PlatformFinanceController,
      'confirmTransfer',
      'write',
      'finance.withdrawal.confirm_transfer',
      'platform',
    ],
    [PlatformFinanceController, 'settle', 'write', 'finance.settlement.manage', 'platform'],
    [PlatformFinanceController, 'policy', 'write', 'finance.settlement.manage', 'platform'],
  ] as const)(
    '%s.%s requires the exact scoped finance permission',
    (controller, method, mode, permission, scope) => {
      const handler = Reflect.get(controller.prototype, method) as Function;
      expect(Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA,
        handler,
      ) as AccessRequirement).toEqual({ mode, permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).not.toBe(true);
    },
  );

  it('derives tenant scope from the authenticated principal and rejects duplicate headers', () => {
    const getTenantWithdrawal = vi.fn();
    const submitWithdrawal = vi.fn();
    const controller = new TenantFinanceController({
      getTenantWithdrawal,
      submitWithdrawal,
    } as unknown as FinanceService);
    const principal: AccessPrincipal = {
      permissions: ['commerce.withdrawal.read', 'commerce.withdrawal.submit'],
      scope: 'tenant',
      subjectId: staffId,
      tenantId,
    };

    controller.withdrawal(withdrawalId, principal);
    expect(getTenantWithdrawal).toHaveBeenCalledWith(tenantId, withdrawalId);
    expect(() => controller.submit(
      {},
      ['duplicate-key-one', 'duplicate-key-two'],
      principal,
    )).toThrow(BadRequestException);
    expect(submitWithdrawal).not.toHaveBeenCalled();
  });

  it('keeps payout decryption behind a permission distinct from ordinary read', () => {
    const getPlatformWithdrawal = vi.fn();
    const getPlatformPayoutAccount = vi.fn();
    const controller = new PlatformFinanceController({
      getPlatformPayoutAccount,
      getPlatformWithdrawal,
    } as unknown as FinanceService);
    const principal: AccessPrincipal = {
      permissions: ['finance.withdrawal.payout_account.read'],
      scope: 'platform',
      subjectId: staffId,
    };

    controller.withdrawal(withdrawalId);
    expect(getPlatformWithdrawal).toHaveBeenCalledWith(withdrawalId);
    expect(getPlatformPayoutAccount).not.toHaveBeenCalled();
    controller.payoutAccount(withdrawalId, principal);
    expect(getPlatformPayoutAccount).toHaveBeenCalledWith(
      withdrawalId,
      staffId,
      expect.any(String),
    );
  });
});
