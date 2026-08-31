import 'reflect-metadata';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerAssetController } from './customer-asset.controller';
import type { CustomerAssetService } from './customer-asset.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';

describe('CustomerAssetController', () => {
  it('is public but derives tenant scope only from a verified active host', () => {
    expect(Reflect.getMetadata(
      PUBLIC_ENDPOINT_METADATA,
      CustomerAssetController.prototype.issue,
    )).toBe(true);
    const issue = vi.fn();
    const active = new CustomerAssetController(
      { issue } as unknown as CustomerAssetService,
      { current: () => ({ tenantId, tenantStatus: 'active' }) } as TenantContextService,
    );
    active.issue(mediaId, {}, { ip: '203.0.113.8' } as never);
    expect(issue).toHaveBeenCalledWith(tenantId, mediaId, {}, '203.0.113.8');
    expect(() => new CustomerAssetController(
      { issue } as unknown as CustomerAssetService,
      { current: () => undefined } as TenantContextService,
    ).issue(mediaId, {}, { ip: '203.0.113.8' } as never))
      .toThrow(BadRequestException);
    expect(() => new CustomerAssetController(
      { issue } as unknown as CustomerAssetService,
      { current: () => ({ tenantId, tenantStatus: 'suspended' }) } as TenantContextService,
    ).issue(mediaId, {}, { ip: '203.0.113.8' } as never))
      .toThrow(ForbiddenException);
  });
});

