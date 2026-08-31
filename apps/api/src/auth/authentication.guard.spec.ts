import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../tenancy/tenant-context.service';
import { AuthenticationGuard } from './authentication.guard';
import type { AuthenticationService } from './authentication.service';
import type { PlatformHostPolicyService } from './platform-host-policy.service';
import { PublicEndpoint } from './public-endpoint.decorator';

class ProtectedController {
  list(): void {}
}

class PublicController {
  @PublicEndpoint()
  login(): void {}
}

describe('AuthenticationGuard', () => {
  it('skips authentication only for an explicitly public handler', async () => {
    const { authentication, guard } = createGuard();

    await expect(
      guard.canActivate(createContext(PublicController, 'login', {})),
    ).resolves.toBe(true);
    expect(authentication.authenticateAccess).not.toHaveBeenCalled();
  });

  it('rejects a protected handler without an exact bearer token', async () => {
    const { guard } = createGuard();

    await expect(
      guard.canActivate(createContext(ProtectedController, 'list', {})),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      guard.canActivate(
        createContext(ProtectedController, 'list', {
          authorization: 'bearer invalid',
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forces a platform token onto an allowed platform host', async () => {
    const { guard, platformHosts } = createGuard({ host: 'wrong.example.com' });
    platformHosts.assertAllowed.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(
      guard.canActivate(
        createContext(ProtectedController, 'list', {
          authorization: `Bearer atk_${'a'.repeat(43)}`,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(platformHosts.assertAllowed).toHaveBeenCalledWith('wrong.example.com');
  });

  it('passes the verified tenant to storage and installs the principal', async () => {
    const { authentication, guard, platformHosts } = createGuard({
      host: 'merchant.example.com',
      tenantId: 'tenant-1',
      tenantStatus: 'active',
    });
    const request: { headers: Record<string, string>; principal?: unknown } = {
      headers: { authorization: `Bearer atk_${'a'.repeat(43)}` },
    };
    authentication.authenticateAccess.mockResolvedValue({
      displayName: 'owner',
      permissions: ['tenant.dashboard.read'],
      scope: 'tenant',
      sessionId: 'session-1',
      subjectId: 'staff-1',
      tenantId: 'tenant-1',
      tenantState: 'active',
    });

    await expect(
      guard.canActivate(
        createContext(ProtectedController, 'list', request.headers, request),
      ),
    ).resolves.toBe(true);
    expect(authentication.authenticateAccess).toHaveBeenCalledWith(
      `atk_${'a'.repeat(43)}`,
      'tenant-1',
    );
    expect(platformHosts.assertAllowed).not.toHaveBeenCalled();
    expect(request.principal).toMatchObject({ scope: 'tenant', tenantId: 'tenant-1' });
  });
});

function createGuard(context?: {
  host: string;
  tenantId?: string;
  tenantStatus?: 'active' | 'expired' | 'suspended';
}) {
  const authentication = {
    authenticateAccess: vi.fn().mockResolvedValue({
      displayName: 'admin',
      permissions: ['platform.dashboard.read'],
      scope: 'platform',
      sessionId: 'session-1',
      subjectId: 'staff-1',
    }),
  };
  const tenantContext = { current: vi.fn().mockReturnValue(context) };
  const platformHosts = { assertAllowed: vi.fn() };
  return {
    authentication,
    guard: new AuthenticationGuard(
      new Reflector(),
      authentication as unknown as AuthenticationService,
      tenantContext as unknown as TenantContextService,
      platformHosts as unknown as PlatformHostPolicyService,
    ),
    platformHosts,
  };
}

function createContext(
  controller: new () => object,
  method: string,
  headers: Record<string, string>,
  request: { headers: Record<string, string>; principal?: unknown } = { headers },
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => controller.prototype[method as keyof object],
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}
