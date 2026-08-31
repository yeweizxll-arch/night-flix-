import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { MerchantSettingsService } from './merchant-settings.service';
import type { MerchantSettingsMutationMetadata } from './merchant-settings.types';

@Controller('platform/merchants')
export class PlatformMerchantSettingsController {
  constructor(
    @Inject(MerchantSettingsService)
    private readonly settings: MerchantSettingsService,
  ) {}

  @Get(':tenantId/site-settings')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.merchant.read'],
    scope: 'platform',
  })
  getSettings(@Param('tenantId') tenantId: string) {
    return this.settings.getPlatformSettings(tenantId);
  }

  @Patch(':tenantId/site-settings')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.merchant.update'],
    scope: 'platform',
  })
  updateSettings(
    @Param('tenantId') tenantId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.updatePlatformBranding(
      tenantId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':tenantId/site-status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.merchant.status'],
    scope: 'platform',
  })
  updateSiteStatus(
    @Param('tenantId') tenantId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.updatePlatformSiteStatus(
      tenantId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Get(':tenantId/domains')
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.merchant.read'],
    scope: 'platform',
  })
  listDomains(@Param('tenantId') tenantId: string) {
    return this.settings.listPlatformDomains(tenantId);
  }

  @Post(':tenantId/domains/subdomains')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.domain.manage'],
    scope: 'platform',
  })
  createSubdomain(
    @Param('tenantId') tenantId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.createPlatformSubdomain(
      tenantId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':tenantId/domains/:domainId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.domain.manage'],
    scope: 'platform',
  })
  updateDomain(
    @Param('tenantId') tenantId: string,
    @Param('domainId') domainId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.updatePlatformDomain(
      tenantId,
      domainId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':tenantId/domains/:domainId/tls-status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.domain.manage'],
    scope: 'platform',
  })
  setTlsStatus(
    @Param('tenantId') tenantId: string,
    @Param('domainId') domainId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.setPlatformDomainTlsStatus(
      tenantId,
      domainId,
      input,
      mutationMetadata(principal, request),
    );
  }
}

@Controller('tenant/site')
export class TenantMerchantSettingsController {
  constructor(
    @Inject(MerchantSettingsService)
    private readonly settings: MerchantSettingsService,
  ) {}

  @Get('settings')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.site.read'],
    scope: 'tenant',
  })
  getSettings(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.settings.getTenantSettings(requireTenantId(principal));
  }

  @Patch('settings')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.site.manage'],
    scope: 'tenant',
  })
  updateSettings(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.updateTenantSettings(
      requireTenantId(principal),
      input,
      mutationMetadata(principal, request),
    );
  }

  @Get('domains')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.domain.read'],
    scope: 'tenant',
  })
  listDomains(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.settings.listTenantDomains(requireTenantId(principal));
  }

  @Post('domains')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.domain.manage'],
    scope: 'tenant',
  })
  createDomain(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.createTenantCustomDomain(
      requireTenantId(principal),
      input,
      mutationMetadata(principal, request),
    );
  }

  @Post('domains/:domainId/verify')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.domain.manage'],
    scope: 'tenant',
  })
  verifyDomain(
    @Param('domainId') domainId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.verifyTenantCustomDomain(
      requireTenantId(principal),
      domainId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch('domains/:domainId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.domain.manage'],
    scope: 'tenant',
  })
  updateDomain(
    @Param('domainId') domainId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.settings.updateTenantDomain(
      requireTenantId(principal),
      domainId,
      input,
      mutationMetadata(principal, request),
    );
  }
}

function requireTenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function mutationMetadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): MerchantSettingsMutationMetadata {
  const idempotencyKey = headerValue(request.headers['idempotency-key']);
  if (!idempotencyKey) throw new BadRequestException('Idempotency-Key is required');
  return {
    actorId: principal.subjectId,
    idempotencyKey,
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new BadRequestException('Idempotency-Key is ambiguous');
    return value[0];
  }
  return value;
}
