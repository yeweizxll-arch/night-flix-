import 'reflect-metadata';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerContentCatalogController } from './customer-content-catalog.controller';
import type { CustomerContentCatalogService } from './customer-content-catalog.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const dramaId = '22222222-2222-4222-8222-222222222222';

describe('CustomerContentCatalogController', () => {
  it('marks both anonymous catalog routes public', () => {
    for (const method of ['list', 'detail'] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerContentCatalogController.prototype[method],
      )).toBe(true);
    }
  });

  it('derives scope only from a verified active tenant domain', async () => {
    const listDramas = vi.fn();
    const getDrama = vi.fn();
    const controller = makeController({ getDrama, listDramas }, {
      tenantId,
      tenantStatus: 'active',
    });

    await controller.list({ locale: 'ja-JP' });
    expect(listDramas).toHaveBeenCalledWith(tenantId, { locale: 'ja-JP' });
    await controller.detail(dramaId, 'fr-FR', { headers: {} } as FastifyRequest);
    expect(getDrama).toHaveBeenCalledWith(tenantId, dramaId, 'fr-FR', undefined);

    await expect(makeController({}, undefined).list({}))
      .rejects.toThrow(BadRequestException);
    await expect(makeController({}, {
      tenantId,
      tenantStatus: 'suspended',
    }).list({})).rejects.toThrow(ForbiddenException);
  });
});

function makeController(
  catalog: Record<string, unknown>,
  context: { tenantId: string; tenantStatus: string } | undefined,
): CustomerContentCatalogController {
  return new CustomerContentCatalogController(
    catalog as unknown as CustomerContentCatalogService,
    { current: vi.fn(() => context) } as unknown as TenantContextService,
    {} as CustomerAuthenticationService,
  );
}
