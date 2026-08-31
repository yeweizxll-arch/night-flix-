import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerAccountController } from './customer-account.controller';
import type { CustomerAuthenticationService } from './customer-authentication.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const accessToken = `atk_${'a'.repeat(43)}`;
const principal = { accountId, deviceId, sessionId, tenantId, username: 'viewer' };

describe('CustomerAccountController', () => {
  it('marks every route Public while explicitly authenticating bearer access', async () => {
    for (const method of ['devices', 'revokeDevice', 'changePassword'] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerAccountController.prototype[method],
      )).toBe(true);
      expect(Reflect.getMetadata(
        HEADERS_METADATA,
        CustomerAccountController.prototype[method],
      )).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    }
    const listDevices = vi.fn(async () => ({ items: [] }));
    const authenticateAccess = vi.fn(async () => principal);
    const controller = makeController({ authenticateAccess, listDevices });

    await expect(controller.devices(request())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(listDevices).not.toHaveBeenCalled();
    await controller.devices(request({ authorization: `Bearer ${accessToken}` }));
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
    expect(listDevices).toHaveBeenCalledWith(principal);
  });

  it('passes only server metadata and one idempotency key to device revocation', async () => {
    const revokeDevice = vi.fn(async () => ({ revoked: true }));
    const authenticateAccess = vi.fn(async () => principal);
    const controller = makeController({ authenticateAccess, revokeDevice });
    await controller.revokeDevice(deviceId, request({
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'revoke-device-command',
      'user-agent': 'customer-test',
    }));
    expect(revokeDevice).toHaveBeenCalledWith(
      principal,
      deviceId,
      expect.objectContaining({
        idempotencyKey: 'revoke-device-command',
        ip: '203.0.113.10',
        requestId: expect.any(String),
        userAgentHash: expect.stringMatching(/^sha256\$/),
      }),
    );

    await expect(controller.revokeDevice(deviceId, request({
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': ['first-key', 'second-key'],
    }))).rejects.toBeInstanceOf(BadRequestException);
    expect(authenticateAccess).toHaveBeenCalledTimes(1);
    expect(revokeDevice).toHaveBeenCalledTimes(1);
  });
});

function makeController(authentication: Record<string, unknown>): CustomerAccountController {
  const context = { current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })) } as unknown as TenantContextService;
  return new CustomerAccountController(
    authentication as unknown as CustomerAuthenticationService,
    context,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
