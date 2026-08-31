import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformMerchantSettingsController,
  TenantMerchantSettingsController,
} from './merchant-settings.controller';
import type { MerchantSettingsService } from './merchant-settings.service';

describe('merchant settings controller policies', () => {
  it.each([
    [PlatformMerchantSettingsController, 'getSettings', 'platform', 'read', 'platform.merchant.read'],
    [PlatformMerchantSettingsController, 'updateSettings', 'platform', 'write', 'platform.merchant.update'],
    [PlatformMerchantSettingsController, 'updateSiteStatus', 'platform', 'write', 'platform.merchant.status'],
    [PlatformMerchantSettingsController, 'listDomains', 'platform', 'read', 'platform.merchant.read'],
    [PlatformMerchantSettingsController, 'createSubdomain', 'platform', 'write', 'platform.domain.manage'],
    [PlatformMerchantSettingsController, 'updateDomain', 'platform', 'write', 'platform.domain.manage'],
    [PlatformMerchantSettingsController, 'setTlsStatus', 'platform', 'write', 'platform.domain.manage'],
    [TenantMerchantSettingsController, 'getSettings', 'tenant', 'read', 'tenant.site.read'],
    [TenantMerchantSettingsController, 'updateSettings', 'tenant', 'write', 'tenant.site.manage'],
    [TenantMerchantSettingsController, 'listDomains', 'tenant', 'read', 'tenant.domain.read'],
    [TenantMerchantSettingsController, 'createDomain', 'tenant', 'write', 'tenant.domain.manage'],
    [TenantMerchantSettingsController, 'verifyDomain', 'tenant', 'write', 'tenant.domain.manage'],
    [TenantMerchantSettingsController, 'updateDomain', 'tenant', 'write', 'tenant.domain.manage'],
  ] as const)('%s.%s has the expected default-deny policy', (
    controller,
    method,
    scope,
    mode,
    permission,
  ) => {
    const handler = Reflect.get(controller.prototype, method) as (...args: never[]) => unknown;
    expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
      .toEqual({ mode, permissions: [permission], scope });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('derives tenantId only from the authenticated tenant principal', () => {
    const settings = { updateTenantSettings: vi.fn() };
    const controller = new TenantMerchantSettingsController(
      settings as unknown as MerchantSettingsService,
    );
    const principal: AccessPrincipal = {
      permissions: ['tenant.site.manage'],
      scope: 'tenant',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773575001',
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e773575002',
    };
    const request = {
      headers: { 'idempotency-key': 'tenant-site-update-001' },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;
    const body = { siteName: 'New name', version: 0 };

    controller.updateSettings(body, principal, request);

    expect(settings.updateTenantSettings).toHaveBeenCalledWith(
      principal.tenantId,
      body,
      expect.objectContaining({
        actorId: principal.subjectId,
        idempotencyKey: 'tenant-site-update-001',
      }),
    );
  });

  it('requires Idempotency-Key for every mutation', () => {
    const controller = new PlatformMerchantSettingsController({
      updatePlatformBranding: vi.fn(),
    } as unknown as MerchantSettingsService);
    const principal: AccessPrincipal = {
      permissions: ['platform.merchant.update'],
      scope: 'platform',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773575001',
    };
    const request = { headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest;

    expect(() => controller.updateSettings(
      '018f2f45-7f5e-7e70-b17f-f6e773575002',
      { version: 0 },
      principal,
      request,
    )).toThrow(BadRequestException);
  });
});
