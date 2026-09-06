import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { TenantDramaDiscoveryController, TenantDramaDiscoveryService } from './tenant-drama-discovery';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import type { AccessPrincipal } from '../access-control';

describe('tenant drama discovery controller', () => {
  it.each([['get', 'read', 'content.drama.read'], ['set', 'write', 'content.drama.update']] as const)(
    '%s enforces explicit tenant permission', (method, mode, permission) => {
      expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, TenantDramaDiscoveryController.prototype[method]))
        .toEqual({ mode, scope: 'tenant', permissions: [permission] });
    });
  it('uses the authenticated tenant and a valid audit identifier, never a body tenant', async () => {
    const set = vi.fn();
    const controller = new TenantDramaDiscoveryController({ set } as unknown as TenantDramaDiscoveryService);
    const principal = { scope: 'tenant', tenantId: 'tenant-a', subjectId: 'staff-a' } as AccessPrincipal;
    const body = { weight: 3, pinnedRank: 0, expectedVersion: 0 };
    controller.set('drama-a', body, principal);
    expect(set).toHaveBeenCalledWith('tenant-a', 'drama-a', body, 'staff-a', expect.stringMatching(/^[a-f0-9-]{36}$/));
    expect(() => controller.get('drama-a', { ...principal, scope: 'platform' }))
      .toThrow(BadRequestException);
  });
});
