import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AccessControlledRequest } from '../access-control';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuthenticationService } from './authentication.service';
import { PUBLIC_ENDPOINT_METADATA } from './public-endpoint.decorator';
import { PlatformHostPolicyService } from './platform-host-policy.service';

interface RequestWithHeaders extends AccessControlledRequest {
  headers?: Record<string, string | string[] | undefined>;
  principal?: unknown;
}

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
    @Inject(PlatformHostPolicyService)
    private readonly platformHosts: PlatformHostPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const authorization = request.headers?.authorization;
    if (typeof authorization !== 'string') {
      throw new UnauthorizedException('Authentication is required');
    }
    const match = /^Bearer (atk_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match?.[1]) {
      throw new UnauthorizedException('Authorization header is invalid');
    }

    const principal = await this.authentication.authenticateAccess(
      match[1],
      this.tenantContext.current()?.tenantId,
    );
    if (principal.scope === 'platform') {
      this.platformHosts.assertAllowed(this.tenantContext.current()?.host);
    }
    request.principal = principal;
    return true;
  }
}
