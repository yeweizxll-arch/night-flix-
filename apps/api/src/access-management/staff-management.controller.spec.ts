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
import { PlatformStaffController } from './platform-staff.controller';
import { StaffManagementService } from './staff-management.service';
import { TenantStaffController } from './tenant-staff.controller';

const ACTOR = '018f2f45-7f5e-7e70-b17f-f6e77357b001';
const TENANT_A = '018f2f45-7f5e-7e70-b17f-f6e77357b002';
const TENANT_B = '018f2f45-7f5e-7e70-b17f-f6e77357b003';
const TOKEN = `atk_${'a'.repeat(43)}`;

describe('staff controller access policies', () => {
  it.each([
    [PlatformStaffController, 'list', 'platform', 'read', 'platform.staff.read'],
    [PlatformStaffController, 'detail', 'platform', 'read', 'platform.staff.read'],
    [PlatformStaffController, 'create', 'platform', 'write', 'platform.staff.manage'],
    [PlatformStaffController, 'updateProfile', 'platform', 'write', 'platform.staff.manage'],
    [PlatformStaffController, 'updateStatus', 'platform', 'write', 'platform.staff.manage'],
    [PlatformStaffController, 'resetPassword', 'platform', 'write', 'platform.staff.password_reset'],
    [PlatformStaffController, 'revokeSessions', 'platform', 'write', 'platform.staff.session_revoke'],
    [TenantStaffController, 'list', 'tenant', 'read', 'tenant.staff.read'],
    [TenantStaffController, 'detail', 'tenant', 'read', 'tenant.staff.read'],
    [TenantStaffController, 'create', 'tenant', 'write', 'tenant.staff.manage'],
    [TenantStaffController, 'updateProfile', 'tenant', 'write', 'tenant.staff.manage'],
    [TenantStaffController, 'updateStatus', 'tenant', 'write', 'tenant.staff.manage'],
    [TenantStaffController, 'resetPassword', 'tenant', 'write', 'tenant.staff.password_reset'],
    [TenantStaffController, 'revokeSessions', 'tenant', 'write', 'tenant.staff.session_revoke'],
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

describe('staff routes through the real APP_GUARD chain', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('denies missing permissions before service execution and allows exact permissions', async () => {
    const fixture = await createGuardedApp(platformPrincipal(['platform.staff.manage']));
    app = fixture.app;
    const server = app.getHttpAdapter().getInstance();
    const deniedRead = await server.inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: '/api/v1/platform/staff',
    });
    expect(deniedRead.statusCode).toBe(403);
    expect(fixture.service.list).not.toHaveBeenCalled();

    fixture.setPrincipal(platformPrincipal(['platform.staff.read']));
    const allowedRead = await server.inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: '/api/v1/platform/staff',
    });
    expect(allowedRead.statusCode).toBe(200);
    expect(fixture.service.list).toHaveBeenCalledOnce();

    const deniedCreate = await server.inject({
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'idempotency-key': 'staff-create-guard-1',
      },
      method: 'POST',
      payload: {},
      url: '/api/v1/platform/staff',
    });
    expect(deniedCreate.statusCode).toBe(403);
    expect(fixture.service.create).not.toHaveBeenCalled();
  });

  it('rejects a tenant token for a different verified host before service execution', async () => {
    const fixture = await createGuardedApp(tenantPrincipal(TENANT_B, ['tenant.staff.read']));
    fixture.setTenantContext({
      host: 'tenant-a.example.test',
      tenantId: TENANT_A,
      tenantStatus: 'active',
    });
    app = fixture.app;
    const response = await app.getHttpAdapter().getInstance().inject({
      headers: { authorization: `Bearer ${TOKEN}` },
      method: 'GET',
      url: '/api/v1/tenant/staff',
    });
    expect(response.statusCode).toBe(403);
    expect(fixture.service.list).not.toHaveBeenCalled();
  });
});

async function createGuardedApp(initialPrincipal: AccessPrincipal) {
  let principal = initialPrincipal;
  let tenantContext: ReturnType<TenantContextService['current']> = {
    host: 'admin.example.test',
  };
  const service = {
    create: vi.fn().mockResolvedValue({ id: ACTOR }),
    detail: vi.fn().mockResolvedValue({ id: ACTOR }),
    list: vi.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
    resetPassword: vi.fn(),
    revokeSessions: vi.fn(),
    updateProfile: vi.fn(),
    updateStatus: vi.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [PlatformStaffController, TenantStaffController],
    providers: [
      Reflector,
      { provide: StaffManagementService, useValue: service },
      {
        provide: AuthenticationService,
        useValue: { authenticateAccess: vi.fn(async () => principal) },
      },
      {
        provide: TenantContextService,
        useValue: { current: vi.fn(() => tenantContext) },
      },
      {
        provide: PlatformHostPolicyService,
        useValue: { assertAllowed: vi.fn() },
      },
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
    setTenantContext(value: ReturnType<TenantContextService['current']>) {
      tenantContext = value;
    },
  };
}

function platformPrincipal(permissions: string[]): AccessPrincipal {
  return { permissions, scope: 'platform', subjectId: ACTOR };
}

function tenantPrincipal(tenantId: string, permissions: string[]): AccessPrincipal {
  return {
    permissions,
    scope: 'tenant',
    subjectId: ACTOR,
    tenantId,
    tenantState: 'active',
  };
}
