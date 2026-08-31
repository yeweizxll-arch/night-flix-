import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { AccessControlGuard } from '../access-control/access-control.guard';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { AuthenticationService } from '../auth/authentication.service';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import { PlatformHostPolicyService } from '../auth/platform-host-policy.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerManagementService } from './customer-management.service';
import { PlatformCustomerController } from './platform-customer.controller';
import { TenantCustomerController } from './tenant-customer.controller';

const ACTOR = '018f2f45-7f5e-7e70-b17f-f6e77357d001';
const ACCOUNT = '018f2f45-7f5e-7e70-b17f-f6e77357d002';
const TENANT_A = '018f2f45-7f5e-7e70-b17f-f6e77357d003';
const TENANT_B = '018f2f45-7f5e-7e70-b17f-f6e77357d004';
const TOKEN = `atk_${'a'.repeat(43)}`;

describe('customer management controller access policies', () => {
  it.each([
    [PlatformCustomerController, 'list', 'platform', 'read', 'platform.customer.read'],
    [PlatformCustomerController, 'detail', 'platform', 'read', 'platform.customer.read'],
    [PlatformCustomerController, 'updateStatus', 'platform', 'write', 'platform.customer.manage'],
    [PlatformCustomerController, 'revokeSessions', 'platform', 'write', 'platform.customer.session_revoke'],
    [TenantCustomerController, 'list', 'tenant', 'read', 'tenant.customer.read'],
    [TenantCustomerController, 'detail', 'tenant', 'read', 'tenant.customer.read'],
    [TenantCustomerController, 'updateStatus', 'tenant', 'write', 'tenant.customer.manage'],
    [TenantCustomerController, 'revokeSessions', 'tenant', 'write', 'tenant.customer.session_revoke'],
  ] as const)(
    '%s.%s has a non-public exact policy',
    (controller, method, scope, mode, permission) => {
      const handler = controller.prototype[method] as (...args: never[]) => unknown;
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
      expect(
        Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement,
      ).toEqual({ mode, permissions: [permission], scope });
    },
  );
});

describe('customer management routes through the real APP_GUARD chain', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('denies missing permissions before service execution and allows exact read permission', async () => {
    const fixture = await createGuardedApp(platformPrincipal(['platform.customer.manage']));
    app = fixture.app;
    const server = app.getHttpAdapter().getInstance();
    const url = `/api/v1/platform/customers?tenantId=${TENANT_A}`;
    const denied = await server.inject({
      headers: { authorization: `Bearer ${TOKEN}` }, method: 'GET', url,
    });
    expect(denied.statusCode).toBe(403);
    expect(fixture.service.list).not.toHaveBeenCalled();

    fixture.setPrincipal(platformPrincipal(['platform.customer.read']));
    const allowed = await server.inject({
      headers: { authorization: `Bearer ${TOKEN}` }, method: 'GET', url,
    });
    expect(allowed.statusCode).toBe(200);
    expect(fixture.service.list).toHaveBeenCalledOnce();
  });

  it('rejects a tenant token for a different verified host before service execution', async () => {
    const fixture = await createGuardedApp(tenantPrincipal(TENANT_B, ['tenant.customer.read']));
    fixture.setTenantContext({
      host: 'tenant-a.example.test', tenantId: TENANT_A, tenantStatus: 'active',
    });
    app = fixture.app;
    const response = await app.getHttpAdapter().getInstance().inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: '/api/v1/tenant/customers',
    });
    expect(response.statusCode).toBe(403);
    expect(fixture.service.list).not.toHaveBeenCalled();
  });

  it('keeps an expired merchant read-only even when the principal owns write permission', async () => {
    const fixture = await createGuardedApp(tenantPrincipal(
      TENANT_A, ['tenant.customer.manage'], 'expired',
    ));
    fixture.setTenantContext({
      host: 'tenant-a.example.test', tenantId: TENANT_A, tenantStatus: 'expired',
    });
    app = fixture.app;
    const response = await app.getHttpAdapter().getInstance().inject({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'idempotency-key': 'customer-status-guard-1',
      },
      method: 'PATCH',
      payload: { expectedVersion: 0, reason: 'security review', status: 'disabled' },
      url: `/api/v1/tenant/customers/${ACCOUNT}/status`,
    });
    expect(response.statusCode).toBe(403);
    expect(fixture.service.updateStatus).not.toHaveBeenCalled();
  });
});

async function createGuardedApp(initialPrincipal: AccessPrincipal) {
  let principal = initialPrincipal;
  let tenantContext: ReturnType<TenantContextService['current']> = { host: 'admin.example.test' };
  const service = {
    detail: vi.fn().mockResolvedValue({ id: ACCOUNT }),
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null, pageSize: 20 }),
    revokeSessions: vi.fn().mockResolvedValue({ accountId: ACCOUNT, sessionsRevoked: 0 }),
    updateStatus: vi.fn().mockResolvedValue({ id: ACCOUNT }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [PlatformCustomerController, TenantCustomerController],
    providers: [
      Reflector,
      { provide: CustomerManagementService, useValue: service },
      { provide: AuthenticationService, useValue: {
        authenticateAccess: vi.fn(async () => principal),
      } },
      { provide: TenantContextService, useValue: {
        current: vi.fn(() => tenantContext),
      } },
      { provide: PlatformHostPolicyService, useValue: { assertAllowed: vi.fn() } },
      { provide: APP_GUARD, useClass: AuthenticationGuard },
      { provide: APP_GUARD, useClass: AccessControlGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api/v1');
  await app.init();
  return {
    app,
    service,
    setPrincipal(value: AccessPrincipal) { principal = value; },
    setTenantContext(value: ReturnType<TenantContextService['current']>) { tenantContext = value; },
  };
}

function platformPrincipal(permissions: string[]): AccessPrincipal {
  return { permissions, scope: 'platform', subjectId: ACTOR };
}

function tenantPrincipal(
  tenantId: string,
  permissions: string[],
  tenantState: 'active' | 'expired' | 'suspended' = 'active',
): AccessPrincipal {
  return { permissions, scope: 'tenant', subjectId: ACTOR, tenantId, tenantState };
}
