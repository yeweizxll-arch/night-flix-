import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  type Type,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { TenantContextService } from '../tenancy/tenant-context.service';
import { AccessControlGuard } from './access-control.guard';
import type {
  AccessControlledRequest,
  AccessPrincipal,
} from './access-control.types';
import { RequirePermissions } from './require-permissions.decorator';

@RequirePermissions({
  scope: 'platform',
  mode: 'read',
  permissions: ['platform.dashboard.read'],
})
class PlatformReadController {
  list(): void {}
}

@RequirePermissions({
  scope: 'tenant',
  mode: 'read',
  permissions: ['drama.read'],
})
class TenantReadController {
  list(): void {}

  @RequirePermissions({
    scope: 'tenant',
    mode: 'write',
    permissions: ['drama.write', 'audit.create'],
  })
  update(): void {}
}

class UnprotectedController {
  list(): void {}
}

const platformPrincipal: AccessPrincipal = {
  subjectId: 'platform-user-1',
  scope: 'platform',
  permissions: ['platform.dashboard.read'],
};

const activeTenantPrincipal: AccessPrincipal = {
  subjectId: 'tenant-user-1',
  scope: 'tenant',
  tenantId: 'tenant-1',
  tenantState: 'active',
  permissions: ['drama.read', 'drama.write', 'audit.create'],
};

describe('AccessControlGuard', () => {
  it('denies a handler with no explicit access metadata', () => {
    const { guard } = createGuard();

    expect(() =>
      guard.canActivate(
        createHttpContext(UnprotectedController, 'list', {
          method: 'GET',
          principal: platformPrincipal,
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies a request without an authenticated principal', () => {
    const { guard } = createGuard();

    expect(() =>
      guard.canActivate(
        createHttpContext(PlatformReadController, 'list', { method: 'GET' }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it.each([
    null,
    {},
    { subjectId: '', scope: 'platform', permissions: [] },
    { subjectId: 'user-1', scope: 'unknown', permissions: [] },
    { subjectId: 'user-1', scope: 'platform', permissions: 'permission' },
    {
      subjectId: 'user-1',
      scope: 'tenant',
      permissions: ['drama.read'],
      tenantId: 'tenant-1',
    },
  ])('denies malformed principal %#', (principal) => {
    const { guard } = createGuard();

    expect(() =>
      guard.canActivate(
        createHttpContext(PlatformReadController, 'list', {
          method: 'GET',
          principal,
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('allows an authenticated platform principal with every permission', () => {
    const { guard } = createGuard();

    expect(
      guard.canActivate(
        createHttpContext(PlatformReadController, 'list', {
          method: 'GET',
          principal: platformPrincipal,
        }),
      ),
    ).toBe(true);
  });

  it('requires every permission declared by the handler override', () => {
    const { guard } = createGuard('tenant-1');

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'update', {
          method: 'PATCH',
          principal: {
            ...activeTenantPrincipal,
            permissions: ['drama.write'],
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('uses handler metadata in preference to controller metadata', () => {
    const { guard } = createGuard('tenant-1');

    expect(
      guard.canActivate(
        createHttpContext(TenantReadController, 'update', {
          method: 'PATCH',
          principal: activeTenantPrincipal,
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ['platform route', TenantReadController, 'list', platformPrincipal],
    ['tenant route', PlatformReadController, 'list', activeTenantPrincipal],
  ] as const)(
    'denies a principal with the wrong scope on a %s',
    (_label, controller, handler, principal) => {
      const { guard } = createGuard('tenant-1');

      expect(() =>
        guard.canActivate(
          createHttpContext(controller, handler, {
            method: 'GET',
            principal,
          }),
        ),
      ).toThrow(ForbiddenException);
    },
  );

  it('denies tenant access when the verified host has no tenant', () => {
    const { guard } = createGuard();

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'list', {
          method: 'GET',
          principal: activeTenantPrincipal,
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies cross-tenant access', () => {
    const { guard } = createGuard('tenant-2');

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'list', {
          method: 'GET',
          principal: activeTenantPrincipal,
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows an active tenant with matching host and permissions', () => {
    const { guard } = createGuard('tenant-1');

    expect(
      guard.canActivate(
        createHttpContext(TenantReadController, 'list', {
          method: 'GET',
          principal: activeTenantPrincipal,
        }),
      ),
    ).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS']) (
    'allows an expired tenant to use an explicitly read-only %s endpoint',
    (method) => {
      const { guard } = createGuard('tenant-1');

      expect(
        guard.canActivate(
          createHttpContext(TenantReadController, 'list', {
            method,
            principal: {
              ...activeTenantPrincipal,
              tenantState: 'expired',
            },
          }),
        ),
      ).toBe(true);
    },
  );

  it('denies an expired tenant on a write policy', () => {
    const { guard } = createGuard('tenant-1');

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'update', {
          method: 'PATCH',
          principal: {
            ...activeTenantPrincipal,
            tenantState: 'expired',
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies an expired tenant when an unsafe HTTP method is mislabeled read', () => {
    const { guard } = createGuard('tenant-1');

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'list', {
          method: 'POST',
          principal: {
            ...activeTenantPrincipal,
            tenantState: 'expired',
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('denies a suspended tenant even for a read-only endpoint', () => {
    const { guard } = createGuard('tenant-1');

    expect(() =>
      guard.canActivate(
        createHttpContext(TenantReadController, 'list', {
          method: 'GET',
          principal: {
            ...activeTenantPrincipal,
            tenantState: 'suspended',
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});

function createGuard(tenantId?: string): {
  guard: AccessControlGuard;
  tenantContext: TenantContextService;
} {
  const tenantContext = {
    current: () => ({ host: 'example.test', tenantId }),
  } as TenantContextService;

  return {
    guard: new AccessControlGuard(new Reflector(), tenantContext),
    tenantContext,
  };
}

function createHttpContext<
  Controller extends object,
  Method extends Extract<keyof Controller, string>,
>(
  controller: Type<Controller>,
  method: Method,
  request: AccessControlledRequest,
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => controller.prototype[method] as () => unknown,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}
