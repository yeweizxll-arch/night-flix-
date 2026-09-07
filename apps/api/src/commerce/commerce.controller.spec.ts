import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CustomerCommerceController,
  TenantCommerceCatalogController,
  TenantCommerceOrderController,
} from './commerce.controller';
import type { CommerceOrderService } from './commerce-order.service';
import type { CommerceOrderInput } from './commerce.types';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const accessToken = `atk_${'a'.repeat(43)}`;
const input: CommerceOrderInput = {
  currency: 'USD',
  locale: 'en-US',
  productId: '33333333-3333-4333-8333-333333333333',
  productType: 'membership',
};

describe('CustomerCommerceController', () => {
  it('marks every manually authenticated customer endpoint public', () => {
    for (const method of ['quote', 'createOrder', 'listOrders', 'getOrder'] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerCommerceController.prototype[method],
      )).toBe(true);
    }
  });

  it('still requires and verifies a bearer token on public commerce routes', async () => {
    const quote = vi.fn(async () => ({ totalMinor: 100 }));
    const authenticateAccess = vi.fn(async () => ({
      accountId,
      tenantId,
      username: 'buyer',
    }));
    const controller = makeController({ quote }, { authenticateAccess });

    await expect(controller.quote(input, request())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authenticateAccess).not.toHaveBeenCalled();

    await expect(controller.quote(
      input,
      request({ authorization: `Bearer ${accessToken}` }),
    )).resolves.toEqual({ totalMinor: 100 });
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ accountId, tenantId }), input);
  });

  it('rejects duplicate Idempotency-Key headers before authentication or order creation', async () => {
    const createOrder = vi.fn();
    const authenticateAccess = vi.fn();
    const controller = makeController({ createOrder }, { authenticateAccess });

    await expect(controller.createOrder(
      input,
      request({ 'idempotency-key': ['commerce-key-one', 'commerce-key-two'] }),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe('tenant staff commerce controllers', () => {
  it.each([
    [TenantCommerceOrderController, 'list', 'read', 'commerce.order.read'],
    [TenantCommerceOrderController, 'get', 'read', 'commerce.order.read'],
    [TenantCommerceCatalogController, 'replaceMembershipTranslations', 'write', 'commerce.catalog.manage'],
    [TenantCommerceCatalogController, 'replacePointsTranslations', 'write', 'commerce.catalog.manage'],
    [TenantCommerceCatalogController, 'upsertContentPointPrice', 'write', 'commerce.catalog.manage'],
    [TenantCommerceCatalogController, 'contentOptions', 'read', 'commerce.catalog.read'],
  ] as const)('%s.%s is protected by tenant permissions', (controller, method, mode, permission) => {
    const handler = Reflect.get(controller.prototype, method) as Function;
    expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
      .toEqual({ mode, permissions: [permission], scope: 'tenant' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('derives staff order tenantId from the authenticated principal', () => {
    const listTenantOrders = vi.fn();
    const controller = new TenantCommerceOrderController({
      listTenantOrders,
    } as unknown as CommerceOrderService);
    const principal: AccessPrincipal = {
      permissions: ['commerce.order.read'],
      scope: 'tenant',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773574103',
      tenantId,
    };
    const query = { page: '2', tenantId: '44444444-4444-4444-8444-444444444444' };

    controller.list(query, principal);

    expect(listTenantOrders).toHaveBeenCalledWith(tenantId, {
      orderType: undefined,
      page: '2',
      pageSize: undefined,
      q: undefined,
      status: undefined,
    });
  });
});

function makeController(
  orders: Record<string, unknown> = {},
  authentication: Record<string, unknown> = {},
): CustomerCommerceController {
  return new CustomerCommerceController(
    orders as unknown as CommerceOrderService,
    authentication as unknown as CustomerAuthenticationService,
    {
      current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
    } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
