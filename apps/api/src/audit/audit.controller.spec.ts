import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  ACCESS_REQUIREMENT_METADATA,
  type AccessPrincipal,
} from '../access-control';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  PlatformAuditController,
  TenantAuditController,
} from './audit.controller';
import type { AuditService } from './audit.service';

const tenantId = '11111111-1111-4111-8111-111111111111';

describe('audit controllers', () => {
  it('declares separate platform and tenant read permissions', () => {
    expect(Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      PlatformAuditController.prototype.list,
    )).toEqual({
      mode: 'read',
      permissions: ['platform.audit.read'],
      scope: 'platform',
    });
    expect(Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      TenantAuditController.prototype.list,
    )).toEqual({
      mode: 'read',
      permissions: ['tenant.audit.read'],
      scope: 'tenant',
    });
  });

  it('uses only the verified current tenant and rejects a mismatched principal', async () => {
    const listTenant = vi.fn(async () => ({ items: [] }));
    const controller = new TenantAuditController(
      { listTenant } as unknown as AuditService,
      { current: vi.fn(() => ({ tenantId })) } as unknown as TenantContextService,
    );
    const principal = {
      scope: 'tenant',
      subjectId: '22222222-2222-4222-8222-222222222222',
      tenantId,
    } as AccessPrincipal;

    await expect(controller.list({ pageSize: '10' }, principal)).resolves.toEqual({ items: [] });
    expect(listTenant).toHaveBeenCalledWith(tenantId, { pageSize: '10' });

    expect(() => controller.list({}, {
      ...principal,
      tenantId: '33333333-3333-4333-8333-333333333333',
    })).toThrow(ForbiddenException);
  });
});
