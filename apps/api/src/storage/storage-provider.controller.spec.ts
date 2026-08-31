import type { FastifyRequest } from 'fastify';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformStorageProviderController,
  TenantStorageProviderController,
} from './storage-provider.controller';
import type { StorageProviderService } from './storage-provider.service';

describe('storage provider controller policies', () => {
  it.each([
    [PlatformStorageProviderController, 'list', 'platform', 'read', 'platform.storage.read'],
    [PlatformStorageProviderController, 'create', 'platform', 'write', 'platform.storage.manage'],
    [PlatformStorageProviderController, 'update', 'platform', 'write', 'platform.storage.manage'],
    [PlatformStorageProviderController, 'setStatus', 'platform', 'write', 'platform.storage.manage'],
    [PlatformStorageProviderController, 'delete', 'platform', 'write', 'platform.storage.manage'],
    [TenantStorageProviderController, 'list', 'tenant', 'read', 'tenant.storage.read'],
    [TenantStorageProviderController, 'create', 'tenant', 'write', 'tenant.storage.manage'],
    [TenantStorageProviderController, 'update', 'tenant', 'write', 'tenant.storage.manage'],
    [TenantStorageProviderController, 'setStatus', 'tenant', 'write', 'tenant.storage.manage'],
    [TenantStorageProviderController, 'delete', 'tenant', 'write', 'tenant.storage.manage'],
  ] as const)(
    '%s.%s requires the expected access policy',
    (controller, method, scope, mode, permission) => {
      const handler = Reflect.get(controller.prototype, method) as (...args: never[]) => unknown;
      const requirement = Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA,
        handler,
      ) as AccessRequirement;
      expect(requirement).toEqual({ mode, permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('derives the tenant from the principal and forwards create idempotency', () => {
    const providers = { createTenant: vi.fn() };
    const controller = new TenantStorageProviderController(
      providers as unknown as StorageProviderService,
    );
    const principal: AccessPrincipal = {
      permissions: ['tenant.storage.manage'],
      scope: 'tenant',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773575001',
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e773575002',
    };
    const request = {
      headers: { 'idempotency-key': 'storage-provider-create-1' },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;
    const input = { provider: 's3' };

    controller.create(input, principal, request);

    expect(providers.createTenant).toHaveBeenCalledWith(
      principal.tenantId,
      input,
      expect.objectContaining({
        actorId: principal.subjectId,
        idempotencyKey: 'storage-provider-create-1',
      }),
    );
  });

  it('rejects create when Idempotency-Key is missing', () => {
    const controller = new PlatformStorageProviderController({
      createPlatform: vi.fn(),
    } as unknown as StorageProviderService);
    const principal: AccessPrincipal = {
      permissions: ['platform.storage.manage'],
      scope: 'platform',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773575001',
    };
    const request = {
      headers: {},
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    expect(() => controller.create({}, principal, request))
      .toThrow(BadRequestException);
  });
});
