import 'reflect-metadata';

import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerAuthenticationController } from './customer-authentication.controller';
import type { CustomerAuthenticationService } from './customer-authentication.service';
import type { CustomerOtpService } from './customer-otp.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('CustomerAuthenticationController', () => {
  it('marks every self-authenticated customer endpoint public at the global guard', () => {
    for (const method of [
      'register',
      'createOtp',
      'verifyOtp',
      'login',
      'refresh',
      'logout',
      'resetPassword',
      'disableOwnAccount',
    ] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerAuthenticationController.prototype[method],
      )).toBe(true);
    }
  });

  it('still performs explicit bearer authentication on the public account endpoint', async () => {
    const authenticateAccessForAccountClosure = vi.fn(async () => ({
      accountId,
      deviceId,
      sessionId,
      tenantId,
      username: 'viewer',
    }));
    const disableOwnAccount = vi.fn(async () => ({ disabled: true as const }));
    const controller = makeController({
      authenticateAccessForAccountClosure,
      disableOwnAccount,
    });

    await expect(controller.disableOwnAccount(
      { reason: 'requested' },
      request(),
    )).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authenticateAccessForAccountClosure).not.toHaveBeenCalled();

    await expect(controller.disableOwnAccount(
      { reason: 'requested' },
      request({ authorization: `Bearer ${accessToken}` }),
    )).resolves.toEqual({ disabled: true });
    expect(authenticateAccessForAccountClosure).toHaveBeenCalledWith(
      tenantId,
      accessToken,
    );
    expect(disableOwnAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, tenantId }),
      'requested',
      expect.objectContaining({ ip: '203.0.113.10', requestId: expect.any(String) }),
    );
  });

  it('rejects unknown, expired, suspended, or indeterminate tenants before auth work', async () => {
    const login = vi.fn();
    const register = vi.fn();
    const createChallenge = vi.fn();

    const unknown = makeController(
      { login, register },
      { createChallenge },
      {},
    );
    await expect(unknown.register({} as never, request())).rejects.toBeInstanceOf(
      BadRequestException,
    );

    for (const tenantStatus of ['expired', 'suspended', undefined] as const) {
      const unavailable = makeController(
        { login, register },
        { createChallenge },
        { tenantId, tenantStatus },
      );
      await expect(unavailable.login({} as never, request())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(unavailable.createOtp({} as never, request())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(unavailable.logout({})).rejects.toBeInstanceOf(ForbiddenException);
      await expect(unavailable.disableOwnAccount(
        { reason: 'requested' },
        request({ authorization: `Bearer ${accessToken}` }),
      )).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(login).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it('passes request metadata to OTP challenge creation for distributed limiting', async () => {
    const createChallenge = vi.fn(async () => ({ challengeId: sessionId }));
    const controller = makeController({}, { createChallenge });
    const input = {
      channel: 'email' as const,
      destination: 'viewer@example.com',
      purpose: 'verify_email' as const,
    };

    await controller.createOtp(input, request({ 'user-agent': 'customer-test' }));
    expect(createChallenge).toHaveBeenCalledWith(
      tenantId,
      input,
      expect.objectContaining({
        ip: '203.0.113.10',
        requestId: expect.any(String),
        userAgentHash: expect.stringMatching(/^sha256\$/),
      }),
    );
  });

  it('exposes accountless password reset without bearer auth and passes only server metadata', async () => {
    const resetPassword = vi.fn(async () => ({ reset: true }));
    const controller = makeController({ resetPassword });
    const input = {
      channel: 'email',
      destination: 'viewer@example.com',
      newPassword: 'new customer password',
      verificationToken: `prg_${'a'.repeat(43)}`,
    };
    await controller.resetPassword(input, request({ 'user-agent': 'reset-test' }));
    expect(resetPassword).toHaveBeenCalledWith(
      tenantId,
      input,
      expect.objectContaining({
        ip: '203.0.113.10',
        requestId: expect.any(String),
        userAgentHash: expect.stringMatching(/^sha256\$/),
      }),
    );
  });
});

function makeController(
  authentication: Record<string, unknown> = {},
  otp: Record<string, unknown> = {},
  context: { tenantId?: string; tenantStatus?: 'active' | 'expired' | 'suspended' } | undefined = {
    tenantId,
    tenantStatus: 'active',
  },
): CustomerAuthenticationController {
  return new CustomerAuthenticationController(
    authentication as unknown as CustomerAuthenticationService,
    otp as unknown as CustomerOtpService,
    { current: vi.fn(() => context) } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
