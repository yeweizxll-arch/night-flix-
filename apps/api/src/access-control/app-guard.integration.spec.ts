import {
  Controller,
  Get,
  Inject,
  Injectable,
  MiddlewareConsumer,
  Module,
  NestMiddleware,
  NestModule,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationGuard } from '../auth/authentication.guard';
import { AuthenticationService } from '../auth/authentication.service';
import type { StoredSessionPrincipal } from '../auth/authentication.types';
import { PlatformHostPolicyService } from '../auth/platform-host-policy.service';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { DatabaseService } from '../database/database.service';
import { MerchantController } from '../merchants/merchant.controller';
import { MerchantService } from '../merchants/merchant.service';
import type { MerchantRecord } from '../merchants/merchant.types';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AccessControlGuard } from './access-control.guard';
import { RequirePermissions } from './require-permissions.decorator';

const TOKENS = {
  lifecycle: `atk_${'l'.repeat(43)}`,
  platformRead: `atk_${'r'.repeat(43)}`,
  profile: `atk_${'p'.repeat(43)}`,
  tenantA: `atk_${'t'.repeat(43)}`,
} as const;

@Controller('guard-acceptance')
@PublicEndpoint()
class GuardAcceptanceController {
  @Get('public')
  publicEndpoint(): { public: true } {
    return { public: true };
  }

  @Get('protected')
  @RequirePermissions({
    scope: 'platform',
    mode: 'read',
    permissions: ['platform.merchant.read'],
  })
  protectedEndpoint(): { protected: true } {
    return { protected: true };
  }

  @Get('tenant')
  @RequirePermissions({
    scope: 'tenant',
    mode: 'read',
    permissions: ['tenant.dashboard.read'],
  })
  tenantEndpoint(): { tenant: true } {
    return { tenant: true };
  }
}

@Injectable()
class AcceptanceAuthenticationService {
  readonly authenticateAccess = vi.fn(
    async (accessToken: string): Promise<StoredSessionPrincipal> => {
      const basePrincipal = {
        displayName: 'Acceptance User',
        sessionId: 'session-1',
        subjectId: 'staff-1',
      };

      switch (accessToken) {
        case TOKENS.platformRead:
          return {
            ...basePrincipal,
            permissions: ['platform.merchant.read'],
            scope: 'platform',
          };
        case TOKENS.profile:
          return {
            ...basePrincipal,
            permissions: ['platform.merchant.update'],
            scope: 'platform',
          };
        case TOKENS.lifecycle:
          return {
            ...basePrincipal,
            permissions: ['platform.merchant.status'],
            scope: 'platform',
          };
        case TOKENS.tenantA:
          return {
            ...basePrincipal,
            permissions: ['tenant.dashboard.read'],
            scope: 'tenant',
            tenantId: 'tenant-a',
            tenantState: 'active',
          };
        default:
          throw new UnauthorizedException('Access token is invalid');
      }
    },
  );
}

const merchantRecord: MerchantRecord = {
  code: 'merchant-a',
  createdAt: '2026-01-01T00:00:00.000Z',
  defaultCurrency: 'USD',
  defaultLocale: 'en-US',
  expiresAt: '2030-01-01T00:00:00.000Z',
  id: 'tenant-a',
  name: 'Merchant A',
  primaryDomain: 'tenant-a.example.test',
  status: 'active',
  timezone: 'UTC',
  version: 1,
};

@Injectable()
class AcceptanceMerchantService {
  readonly create = vi.fn(async (): Promise<MerchantRecord> => merchantRecord);
  readonly list = vi.fn(async () => ({
    items: [merchantRecord],
    page: 1,
    pageSize: 20,
    total: 1,
  }));
  readonly update = vi.fn(async (): Promise<MerchantRecord> => merchantRecord);
}

@Injectable()
class AcceptanceTenantContextMiddleware
  implements NestMiddleware<IncomingMessage, ServerResponse>
{
  constructor(
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  use(
    request: IncomingMessage,
    _response: ServerResponse,
    next: (error?: Error | unknown) => void,
  ): void {
    const hostHeader = request.headers.host ?? '';
    const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
    const tenant = host === 'tenant-a.example.test'
      ? { tenantId: 'tenant-a', tenantStatus: 'active' as const }
      : host === 'tenant-b.example.test'
        ? { tenantId: 'tenant-b', tenantStatus: 'active' as const }
        : {};

    this.tenantContext.run({ host, ...tenant }, next);
  }
}

@Module({
  controllers: [GuardAcceptanceController, MerchantController],
  providers: [
    TenantContextService,
    AcceptanceTenantContextMiddleware,
    AcceptanceAuthenticationService,
    {
      provide: AuthenticationService,
      useExisting: AcceptanceAuthenticationService,
    },
    AcceptanceMerchantService,
    { provide: MerchantService, useExisting: AcceptanceMerchantService },
    { provide: DatabaseService, useValue: { resolverConfigured: false } },
    PlatformHostPolicyService,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AccessControlGuard },
  ],
})
class GuardAcceptanceModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AcceptanceTenantContextMiddleware).forRoutes({
      path: '{*path}',
      method: RequestMethod.ALL,
    });
  }
}

describe('global authentication and access-control guard chain', () => {
  let app: NestFastifyApplication;
  let authentication: AcceptanceAuthenticationService;
  let merchants: AcceptanceMerchantService;
  let previousPlatformHosts: string | undefined;

  beforeAll(async () => {
    previousPlatformHosts = process.env.PLATFORM_ADMIN_HOSTS;
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.test';

    const moduleRef = await Test.createTestingModule({
      imports: [GuardAcceptanceModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    authentication = app.get(AcceptanceAuthenticationService);
    merchants = app.get(AcceptanceMerchantService);
  });

  afterAll(async () => {
    await app.close();
    if (previousPlatformHosts === undefined) {
      delete process.env.PLATFORM_ADMIN_HOSTS;
    } else {
      process.env.PLATFORM_ADMIN_HOSTS = previousPlatformHosts;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs authentication before access control and rejects a platform token on an unknown host', async () => {
    const rejected = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.platformRead}`,
        host: 'unknown.example.test',
      },
      method: 'GET',
      url: '/platform/merchants',
    });

    expect(rejected.statusCode).toBe(403);
    expect(authentication.authenticateAccess).toHaveBeenCalledOnce();

    const allowed = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.platformRead}`,
        host: 'admin.example.test',
      },
      method: 'GET',
      url: '/platform/merchants',
    });

    expect(allowed.statusCode).toBe(200);
    expect(merchants.list).toHaveBeenCalledOnce();
  });

  it('rejects a tenant principal on another merchant host', async () => {
    const rejected = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.tenantA}`,
        host: 'tenant-b.example.test',
      },
      method: 'GET',
      url: '/guard-acceptance/tenant',
    });
    expect(rejected.statusCode).toBe(403);
    expect(authentication.authenticateAccess).toHaveBeenLastCalledWith(
      TOKENS.tenantA,
      'tenant-b',
    );

    const allowed = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.tenantA}`,
        host: 'tenant-a.example.test',
      },
      method: 'GET',
      url: '/guard-acceptance/tenant',
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('keeps merchant profile and lifecycle permissions independent', async () => {
    const profileAllowed = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.profile}`,
        host: 'admin.example.test',
      },
      method: 'PATCH',
      payload: { name: 'Renamed merchant', reason: 'Brand update', version: 0 },
      url: '/platform/merchants/tenant-a/profile',
    });
    expect(profileAllowed.statusCode).toBe(200);

    const profileDeniedLifecycle = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.profile}`,
        host: 'admin.example.test',
      },
      method: 'PATCH',
      payload: { reason: 'Suspend', status: 'suspended', version: 0 },
      url: '/platform/merchants/tenant-a/lifecycle',
    });
    expect(profileDeniedLifecycle.statusCode).toBe(403);

    const lifecycleAllowed = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.lifecycle}`,
        host: 'admin.example.test',
      },
      method: 'PATCH',
      payload: { reason: 'Suspend', status: 'suspended', version: 0 },
      url: '/platform/merchants/tenant-a/lifecycle',
    });
    expect(lifecycleAllowed.statusCode).toBe(200);

    const lifecycleDeniedProfile = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.lifecycle}`,
        host: 'admin.example.test',
      },
      method: 'PATCH',
      payload: { name: 'Renamed merchant', reason: 'Brand update', version: 0 },
      url: '/platform/merchants/tenant-a/profile',
    });
    expect(lifecycleDeniedProfile.statusCode).toBe(403);
    expect(merchants.update).toHaveBeenCalledTimes(2);
  });

  it('does not let public controller metadata expose a handler with an access policy', async () => {
    const publicResponse = await app.inject({
      headers: { host: 'unknown.example.test' },
      method: 'GET',
      url: '/guard-acceptance/public',
    });
    expect(publicResponse.statusCode).toBe(200);

    const protectedWithoutToken = await app.inject({
      headers: { host: 'admin.example.test' },
      method: 'GET',
      url: '/guard-acceptance/protected',
    });
    expect(protectedWithoutToken.statusCode).toBe(401);

    const protectedWithToken = await app.inject({
      headers: {
        authorization: `Bearer ${TOKENS.platformRead}`,
        host: 'admin.example.test',
      },
      method: 'GET',
      url: '/guard-acceptance/protected',
    });
    expect(protectedWithToken.statusCode).toBe(200);
  });
});
