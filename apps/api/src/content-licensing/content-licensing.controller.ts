import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { ContentLicensingService } from './content-licensing.service';
import type {
  CreateLicensePackageInput,
  GrantContentLicenseInput,
  LicensingMutationMetadata,
  ReplaceLicensePackageItemsInput,
  RevokeContentLicenseInput,
} from './content-licensing.types';

@Controller('platform/content-licensing')
export class PlatformContentLicensingController {
  constructor(
    @Inject(ContentLicensingService)
    private readonly licensing: ContentLicensingService,
  ) {}

  @Get('packages')
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.license.read'],
    scope: 'platform',
  })
  listPackages(@Query() query: Record<string, unknown>) {
    return this.licensing.listPackages(
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Post('packages')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.license.manage'],
    scope: 'platform',
  })
  createPackage(
    @Body() input: CreateLicensePackageInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.licensing.createPackage(
      input,
      mutationMetadata(principal, request),
    );
  }

  @Put('packages/:packageId/items')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.license.manage'],
    scope: 'platform',
  })
  replacePackageItems(
    @Param('packageId') packageId: string,
    @Body() input: ReplaceLicensePackageItemsInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.licensing.replacePackageItems(
      packageId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Get('licenses')
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.license.read'],
    scope: 'platform',
  })
  listLicenses(@Query() query: Record<string, unknown>) {
    return this.licensing.listLicenses(
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
      typeof query.tenantId === 'string' ? query.tenantId : undefined,
    );
  }

  @Post('licenses')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.license.manage'],
    scope: 'platform',
  })
  grantLicense(
    @Body() input: GrantContentLicenseInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.licensing.grantLicense(
      input,
      mutationMetadata(principal, request),
    );
  }

  @Post('licenses/:licenseId/revoke')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.license.manage'],
    scope: 'platform',
  })
  revokeLicense(
    @Param('licenseId') licenseId: string,
    @Body() input: RevokeContentLicenseInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.licensing.revokeLicense(
      licenseId,
      input,
      mutationMetadata(principal, request),
    );
  }
}

@Controller('platform/content-library')
export class PlatformContentLibraryController {
  constructor(
    @Inject(ContentLicensingService)
    private readonly licensing: ContentLicensingService,
  ) {}

  @Get('dramas')
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.license.read'],
    scope: 'platform',
  })
  listDramas(@Query() query: Record<string, unknown>) {
    return this.licensing.listPlatformLibraryDramas(
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
      query.status,
      query.q,
    );
  }
}

@Controller('tenant/content-licensing')
export class TenantContentLicensingController {
  constructor(
    @Inject(ContentLicensingService)
    private readonly licensing: ContentLicensingService,
  ) {}

  @Get('dramas')
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.drama.read'],
    scope: 'tenant',
  })
  listLicensedDramas(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.licensing.listTenantLicensedDramas(
      requireTenantId(principal),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }
}

function mutationMetadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): LicensingMutationMetadata {
  return {
    actorId: principal.subjectId,
    idempotencyKey: headerValue(request.headers['idempotency-key']),
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireTenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}
