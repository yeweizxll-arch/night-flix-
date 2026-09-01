import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import type { AdMobSsvVerifierService } from './admob-ssv-verifier.service';
import { RewardedUnlockController } from './rewarded-unlock.controller';
import type { RewardedUnlockService } from './rewarded-unlock.service';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773573202';
const accountId = '018f2f45-7f5e-7e70-b17f-f6e773573203';
const episodeId = '018f2f45-7f5e-7e70-b17f-f6e773573204';
const token = `atk_${'a'.repeat(43)}`;

describe('RewardedUnlockController', () => {
  it('marks challenge, status and callback routes public for explicit auth rules', () => {
    for (const method of ['admobCallback', 'createChallenge', 'status'] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        RewardedUnlockController.prototype[method],
      )).toBe(true);
    }
  });

  it('requires customer auth for challenges while the signed callback needs none', async () => {
    const createChallenge = vi.fn(async () => ({ status: 'pending' }));
    const grantVerifiedReward = vi.fn(async () => ({ granted: true }));
    const verify = vi.fn(async () => ({
      adUnitId: 'unit', challengeId: episodeId, rewardAmount: 1,
      rewardItem: 'episode', transactionId: 'tx-1',
    }));
    const authenticateAccess = vi.fn(async () => ({ accountId, tenantId }));
    const controller = makeController(
      { createChallenge, grantVerifiedReward }, { verify }, { authenticateAccess },
    );
    await expect(controller.createChallenge(
      episodeId, { platform: 'android' }, request(),
    )).rejects.toBeInstanceOf(UnauthorizedException);
    await controller.createChallenge(
      episodeId, { platform: 'android' },
      request({ authorization: `Bearer ${token}` }),
    );
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, token);

    await expect(controller.admobCallback(request())).resolves.toEqual({ ok: true });
    expect(verify).toHaveBeenCalled();
    expect(grantVerifiedReward).toHaveBeenCalled();
  });
});

function makeController(
  rewards: Record<string, unknown>,
  verifier: Record<string, unknown>,
  authentication: Record<string, unknown>,
) {
  const tenantContext = {
    current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
  } as unknown as TenantContextService;
  return new RewardedUnlockController(
    rewards as unknown as RewardedUnlockService,
    verifier as unknown as AdMobSsvVerifierService,
    authentication as unknown as CustomerAuthenticationService,
    tenantContext,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return {
    headers,
    ip: '203.0.113.10',
    raw: { url: '/callback?signature=s&key_id=1' },
  } as FastifyRequest;
}
