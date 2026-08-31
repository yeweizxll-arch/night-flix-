import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
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
import {
  StorageProviderService,
  type StorageProviderMutationMetadata,
} from './storage-provider.service';

@Controller('platform/storage/providers')
export class PlatformStorageProviderController {
  constructor(
    @Inject(StorageProviderService)
    private readonly providers: StorageProviderService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.storage.read'],
    scope: 'platform',
  })
  list(@Query() query: Record<string, unknown>) {
    return this.providers.listPlatform(
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.storage.manage'],
    scope: 'platform',
  })
  create(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.createPlatform(
      input,
      mutationMetadata(principal, request, true),
    );
  }

  @Patch(':providerId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.storage.manage'],
    scope: 'platform',
  })
  update(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.updatePlatform(
      providerId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':providerId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.storage.manage'],
    scope: 'platform',
  })
  setStatus(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.setPlatformStatus(
      providerId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Delete(':providerId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.storage.manage'],
    scope: 'platform',
  })
  delete(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.deletePlatform(
      providerId,
      input,
      mutationMetadata(principal, request),
    );
  }
}

@Controller('tenant/storage/providers')
export class TenantStorageProviderController {
  constructor(
    @Inject(StorageProviderService)
    private readonly providers: StorageProviderService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.storage.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.providers.listTenant(
      requireTenantId(principal),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.storage.manage'],
    scope: 'tenant',
  })
  create(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.createTenant(
      requireTenantId(principal),
      input,
      mutationMetadata(principal, request, true),
    );
  }

  @Patch(':providerId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.storage.manage'],
    scope: 'tenant',
  })
  update(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.updateTenant(
      requireTenantId(principal),
      providerId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':providerId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.storage.manage'],
    scope: 'tenant',
  })
  setStatus(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.setTenantStatus(
      requireTenantId(principal),
      providerId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Delete(':providerId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.storage.manage'],
    scope: 'tenant',
  })
  delete(
    @Param('providerId') providerId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.providers.deleteTenant(
      requireTenantId(principal),
      providerId,
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
  requireIdempotencyKey = false,
): StorageProviderMutationMetadata {
  const idempotencyKey = headerValue(request.headers['idempotency-key']);
  if (requireIdempotencyKey && !idempotencyKey) {
    throw new BadRequestException('Idempotency-Key is required');
  }
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
