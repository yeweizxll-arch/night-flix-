import 'reflect-metadata';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CustomerBootstrapController,
  CustomerNavigationController,
  CustomerReadModelController,
  CustomerStoreCatalogController,
} from './customer-store.controller';
import type { CustomerStoreService } from './customer-store.service';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e77358b101';

describe('customer storefront controllers', () => {
  it('marks bootstrap, catalog, navigation, and manually authenticated reads public', () => {
    const handlers = [
      CustomerBootstrapController.prototype.bootstrap,
      CustomerStoreCatalogController.prototype.catalog,
      CustomerNavigationController.prototype.categories,
      CustomerNavigationController.prototype.tags,
      CustomerReadModelController.prototype.account,
      CustomerReadModelController.prototype.wallet,
      CustomerReadModelController.prototype.ledger,
      CustomerReadModelController.prototype.entitlements,
    ];
    for (const handler of handlers) {
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(true);
    }
  });

  it('manually authenticates bearer access against the verified host tenant', async () => {
    const principal = {
      accountId: '018f2f45-7f5e-7e70-b17f-f6e77358b102',
      deviceId: '018f2f45-7f5e-7e70-b17f-f6e77358b103',
      sessionId: '018f2f45-7f5e-7e70-b17f-f6e77358b104',
      tenantId,
      username: 'reader',
    };
    const authentication = {
      authenticateAccess: vi.fn().mockResolvedValue(principal),
    } as unknown as CustomerAuthenticationService;
    const accountMe = vi.fn().mockResolvedValue({ accountId: principal.accountId });
    const controller = new CustomerReadModelController(
      { accountMe } as unknown as CustomerStoreService,
      authentication,
      { current: () => ({ tenantId, tenantStatus: 'active' }) } as TenantContextService,
    );
    const result = await controller.account({}, {
      headers: { authorization: 'Bearer atk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    } as never);
    expect(authentication.authenticateAccess).toHaveBeenCalledWith(
      tenantId,
      'atk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(accountMe).toHaveBeenCalledWith(principal, {});
    expect(result).toEqual({ accountId: principal.accountId });
  });

  it('requires a verified active host before any public storefront read', () => {
    const store = { bootstrap: vi.fn() } as unknown as CustomerStoreService;
    expect(() => new CustomerBootstrapController(
      store,
      { current: () => undefined } as TenantContextService,
    ).bootstrap({})).toThrow(BadRequestException);
    const suspended = new CustomerBootstrapController(
      store,
      { current: () => ({ tenantId, tenantStatus: 'suspended' }) } as TenantContextService,
    );
    try {
      suspended.bootstrap({});
      throw new Error('Expected suspended host to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'CUSTOMER_SITE_UNAVAILABLE',
      });
    }
    expect(store.bootstrap).not.toHaveBeenCalled();
  });
});
