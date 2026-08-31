import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AccessScope } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuthenticationService } from './authentication.service';
import type {
  AuthenticatedSession,
  SessionRequestMetadata,
} from './authentication.types';
import { PlatformHostPolicyService } from './platform-host-policy.service';
import { PublicEndpoint } from './public-endpoint.decorator';

interface LoginBody {
  password: string;
  username: string;
}

interface SessionResponse {
  accessExpiresAt: string;
  accessToken: string;
  principal: {
    displayName: string;
    id: string;
    permissions: readonly string[];
    scope: AccessScope;
    tenantId?: string;
  };
}

const PLATFORM_REFRESH_COOKIE = 'drama_platform_refresh';
const TENANT_REFRESH_COOKIE = 'drama_tenant_refresh';

@Controller('platform/auth')
export class PlatformAuthenticationController {
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
    @Inject(PlatformHostPolicyService)
    private readonly platformHosts: PlatformHostPolicyService,
  ) {}

  @Post('login')
  @PublicEndpoint()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    this.platformHosts.assertAllowed(request.headers.host);
    assertSameOriginBrowserRequest(request);
    const input = parseLoginBody(body);
    const session = await this.authentication.login(
      'platform',
      input.username,
      input.password,
      requestMetadata(request),
    );
    setRefreshCookie(reply, 'platform', session);
    return toSessionResponse(reply, session);
  }

  @Post('refresh')
  @PublicEndpoint()
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    this.platformHosts.assertAllowed(request.headers.host);
    assertSameOriginBrowserRequest(request);
    const session = await this.authentication.refresh(
      'platform',
      request.cookies[refreshCookieName('platform')] ?? '',
      requestMetadata(request),
    );
    setRefreshCookie(reply, 'platform', session);
    return toSessionResponse(reply, session);
  }

  @Post('logout')
  @PublicEndpoint()
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.platformHosts.assertAllowed(request.headers.host);
    assertSameOriginBrowserRequest(request);
    await this.authentication.logout(
      'platform',
      request.cookies[refreshCookieName('platform')],
      requestMetadata(request),
    );
    clearRefreshCookie(reply, 'platform');
  }
}

@Controller('tenant/auth')
export class TenantAuthenticationController {
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('login')
  @PublicEndpoint()
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    assertSameOriginBrowserRequest(request);
    const tenantId = this.requireTenant();
    this.assertTenantAvailable();
    const input = parseLoginBody(body);
    const session = await this.authentication.login(
      'tenant',
      input.username,
      input.password,
      requestMetadata(request),
      tenantId,
    );
    setRefreshCookie(reply, 'tenant', session);
    return toSessionResponse(reply, session);
  }

  @Post('refresh')
  @PublicEndpoint()
  @HttpCode(200)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    assertSameOriginBrowserRequest(request);
    const tenantId = this.requireTenant();
    this.assertTenantAvailable();
    const session = await this.authentication.refresh(
      'tenant',
      request.cookies[refreshCookieName('tenant')] ?? '',
      requestMetadata(request),
      tenantId,
    );
    setRefreshCookie(reply, 'tenant', session);
    return toSessionResponse(reply, session);
  }

  @Post('logout')
  @PublicEndpoint()
  @HttpCode(204)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    assertSameOriginBrowserRequest(request);
    const tenantId = this.requireTenant();
    await this.authentication.logout(
      'tenant',
      request.cookies[refreshCookieName('tenant')],
      requestMetadata(request),
      tenantId,
    );
    clearRefreshCookie(reply, 'tenant');
  }

  private requireTenant(): string {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    return tenantId;
  }

  private assertTenantAvailable(): void {
    if (this.tenantContext.current()?.tenantStatus === 'suspended') {
      throw new ForbiddenException('Tenant is suspended');
    }
  }
}

function parseLoginBody(body: unknown): LoginBody {
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>).username !== 'string' ||
    typeof (body as Record<string, unknown>).password !== 'string'
  ) {
    throw new BadRequestException('username and password are required');
  }
  const input = body as { password: string; username: string };
  return {
    password: input.password,
    username: input.username,
  };
}

function requestMetadata(request: FastifyRequest): SessionRequestMetadata {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    requestId: uuidV7(),
    userAgentHash: userAgent
      ? `sha256$${createHash('sha256').update(userAgent).digest('base64url')}`
      : undefined,
  };
}

function assertSameOriginBrowserRequest(request: FastifyRequest): void {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new BadRequestException('Cross-origin authentication request is not allowed');
  }

  const origin = request.headers.origin;
  if (!origin) {
    return;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new BadRequestException('Origin header is invalid');
  }
  if (originHost !== request.headers.host?.toLowerCase()) {
    throw new BadRequestException('Authentication request origin does not match host');
  }
}

function refreshCookieName(scope: AccessScope): string {
  const name = scope === 'platform'
    ? PLATFORM_REFRESH_COOKIE
    : TENANT_REFRESH_COOKIE;
  return process.env.NODE_ENV === 'production' ? `__Host-${name}` : name;
}

function setRefreshCookie(
  reply: FastifyReply,
  scope: AccessScope,
  session: AuthenticatedSession,
): void {
  reply.setCookie(refreshCookieName(scope), session.refreshToken, {
    expires: session.refreshExpiresAt,
    httpOnly: true,
    maxAge: Math.max(
      0,
      Math.floor((session.refreshExpiresAt.getTime() - Date.now()) / 1_000),
    ),
    path: '/',
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  });
}

function clearRefreshCookie(reply: FastifyReply, scope: AccessScope): void {
  reply.clearCookie(refreshCookieName(scope), {
    httpOnly: true,
    path: '/',
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
  });
}

function toSessionResponse(
  reply: FastifyReply,
  session: AuthenticatedSession,
): SessionResponse {
  reply.header('Cache-Control', 'no-store');
  return {
    accessExpiresAt: session.accessExpiresAt.toISOString(),
    accessToken: session.accessToken,
    principal: {
      displayName: session.principal.displayName,
      id: session.principal.subjectId,
      permissions: session.principal.permissions,
      scope: session.principal.scope,
      tenantId: session.principal.tenantId,
    },
  };
}
