import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CustomerReferralController,
  TenantReferralController,
} from './referral.controller';
import type { ReferralService } from './referral.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('CustomerReferralController', () => {
  it('keeps all customer routes public only for manual customer bearer authentication', async () => {
    for (const method of ['me', 'ledger', 'createInviteCode', 'bind'] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerReferralController.prototype[method],
      )).toBe(true);
    }
    const getCustomerSummary = vi.fn(async () => ({ inviteCode: null }));
    const authenticateAccess = vi.fn(async () => ({ accountId, tenantId, username: 'buyer' }));
    const controller = customerController({ getCustomerSummary }, { authenticateAccess });
    await expect(controller.me(request())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.me(request({ authorization: `Bearer ${accessToken}` })))
      .resolves.toEqual({ inviteCode: null });
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
  });

  it('rejects ambiguous Idempotency-Key before authentication or writes', async () => {
    const createInviteCode = vi.fn();
    const authenticateAccess = vi.fn();
    const controller = customerController({ createInviteCode }, { authenticateAccess });
    await expect(controller.createInviteCode(
      ['key-one-0001', 'key-two-0002'],
      request({ authorization: `Bearer ${accessToken}` }),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(createInviteCode).not.toHaveBeenCalled();
  });
});

describe('TenantReferralController', () => {
  it.each([
    ['config', 'read', 'commerce.referral.read'],
    ['updateConfig', 'write', 'commerce.referral.manage'],
    ['commissions', 'read', 'commerce.referral.read'],
  ] as const)('%s requires its tenant referral permission', (method, mode, permission) => {
    const handler = Reflect.get(TenantReferralController.prototype, method) as Function;
    expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
      .toEqual({ mode, permissions: [permission], scope: 'tenant' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });
});

function customerController(
  referrals: Record<string, unknown> = {},
  authentication: Record<string, unknown> = {},
): CustomerReferralController {
  return new CustomerReferralController(
    referrals as unknown as ReferralService,
    authentication as unknown as CustomerAuthenticationService,
    {
      current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
    } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
