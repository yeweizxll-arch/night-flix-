import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerPointUnlockController } from './point-unlock.controller';
import type { PointUnlockService } from './point-unlock.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('CustomerPointUnlockController', () => {
  it('is public only for guard routing but still manually verifies bearer authentication', async () => {
    expect(Reflect.getMetadata(
      PUBLIC_ENDPOINT_METADATA,
      CustomerPointUnlockController.prototype.unlock,
    )).toBe(true);
    const unlock = vi.fn(async () => ({ id: 'unlock' }));
    const authenticateAccess = vi.fn(async () => ({
      accountId,
      tenantId,
      username: 'point-buyer',
    }));
    const controller = makeController(unlock, authenticateAccess);

    await expect(controller.unlock(
      'drama', targetId, {}, 'point-controller-key-0001', request(),
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authenticateAccess).not.toHaveBeenCalled();

    await expect(controller.unlock(
      'drama',
      targetId,
      {},
      'point-controller-key-0001',
      request({ authorization: `Bearer ${accessToken}` }),
    )).resolves.toEqual({ id: 'unlock' });
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
    expect(unlock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, tenantId }),
      'drama',
      targetId,
      {},
      'point-controller-key-0001',
      expect.any(String),
    );
  });

  it('rejects ambiguous idempotency headers before authentication', async () => {
    const unlock = vi.fn();
    const authenticateAccess = vi.fn();
    const controller = makeController(unlock, authenticateAccess);

    await expect(controller.unlock(
      'drama',
      targetId,
      {},
      ['point-controller-key-0001', 'point-controller-key-0002'],
      request({ authorization: `Bearer ${accessToken}` }),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
  });
});

function makeController(
  unlock: ReturnType<typeof vi.fn>,
  authenticateAccess: ReturnType<typeof vi.fn>,
): CustomerPointUnlockController {
  return new CustomerPointUnlockController(
    { unlock } as unknown as PointUnlockService,
    { authenticateAccess } as unknown as CustomerAuthenticationService,
    {
      current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
    } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers } as FastifyRequest;
}
