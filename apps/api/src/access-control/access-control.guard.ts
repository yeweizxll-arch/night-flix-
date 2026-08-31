import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { TenantContextService } from '../tenancy/tenant-context.service';
import {
  ACCESS_MODES,
  ACCESS_SCOPES,
  TENANT_ACCESS_STATES,
  type AccessControlledRequest,
  type AccessPrincipal,
  type AccessRequirement,
} from './access-control.types';
import { ACCESS_REQUIREMENT_METADATA } from './require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AccessControlGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ENDPOINT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) {
      return true;
    }

    const requirement = this.reflector.getAllAndOverride<unknown>(
      ACCESS_REQUIREMENT_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!isAccessRequirement(requirement)) {
      throw new ForbiddenException('Access policy is not configured');
    }

    const request = context.switchToHttp().getRequest<AccessControlledRequest>();
    if (!isAccessPrincipal(request.principal)) {
      throw new UnauthorizedException('Authentication is required');
    }

    const principal = request.principal;
    if (principal.scope !== requirement.scope) {
      throw new ForbiddenException('Access scope is not allowed');
    }

    if (!hasRequiredPermissions(principal, requirement)) {
      throw new ForbiddenException('Required permission is missing');
    }

    if (requirement.scope === 'tenant') {
      this.assertTenantAccess(principal, requirement, request.method);
    }

    return true;
  }

  private assertTenantAccess(
    principal: AccessPrincipal,
    requirement: AccessRequirement,
    requestMethod: string | undefined,
  ): void {
    const resolvedTenantId = this.tenantContext.current()?.tenantId;
    if (!resolvedTenantId || principal.tenantId !== resolvedTenantId) {
      throw new ForbiddenException('Tenant access is not allowed');
    }

    if (principal.tenantState === 'suspended') {
      throw new ForbiddenException('Tenant is suspended');
    }

    if (principal.tenantState === 'expired') {
      const method = requestMethod?.toUpperCase();
      if (requirement.mode !== 'read' || !method || !SAFE_HTTP_METHODS.has(method)) {
        throw new ForbiddenException('Expired tenant access is read-only');
      }
    }
  }
}

function hasRequiredPermissions(
  principal: AccessPrincipal,
  requirement: AccessRequirement,
): boolean {
  const granted = new Set(principal.permissions);
  return requirement.permissions.every((permission) => granted.has(permission));
}

function isAccessRequirement(value: unknown): value is AccessRequirement {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.scope === 'string' &&
    ACCESS_SCOPES.some((scope) => scope === value.scope) &&
    typeof value.mode === 'string' &&
    ACCESS_MODES.some((mode) => mode === value.mode) &&
    isNonEmptyStringArray(value.permissions)
  );
}

function isAccessPrincipal(value: unknown): value is AccessPrincipal {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.subjectId !== 'string' ||
    value.subjectId.trim().length === 0 ||
    typeof value.scope !== 'string' ||
    !ACCESS_SCOPES.some((scope) => scope === value.scope) ||
    !isStringArray(value.permissions)
  ) {
    return false;
  }

  if (value.scope === 'platform') {
    return value.tenantId === undefined && value.tenantState === undefined;
  }

  return (
    typeof value.tenantId === 'string' &&
    value.tenantId.trim().length > 0 &&
    typeof value.tenantState === 'string' &&
    TENANT_ACCESS_STATES.some((state) => state === value.tenantState)
  );
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return isStringArray(value) && value.length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
