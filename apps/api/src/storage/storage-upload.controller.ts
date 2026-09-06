import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Param,
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
import {
  type CreateStorageUploadIntentInput,
  StorageUploadService,
  type StorageMutationMetadata,
  type RegisterSourceObjectInput,
} from './storage-upload.service';

@Controller('tenant/content/media/uploads')
export class TenantStorageUploadController {
  constructor(
    @Inject(StorageUploadService)
    private readonly uploads: StorageUploadService,
  ) {}

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.create'],
    scope: 'tenant',
  })
  create(
    @Body() input: CreateStorageUploadIntentInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.createTenantUploadIntent(
      requireTenantId(principal),
      input,
      mutationMetadata(principal, request, true),
    );
  }

  @Post(':mediaId/complete')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.create'],
    scope: 'tenant',
  })
  complete(
    @Param('mediaId') mediaId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.completeTenantUpload(
      requireTenantId(principal),
      mediaId,
      mutationMetadata(principal, request, false),
    );
  }
}

@Controller('platform/content-management/media/uploads')
export class PlatformStorageUploadController {
  constructor(
    @Inject(StorageUploadService)
    private readonly uploads: StorageUploadService,
  ) {}

  @Post('source-reference')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  registerSource(@Body() input: RegisterSourceObjectInput, @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest) {
    return this.uploads.registerPlatformSourceObject(input, platformMutationMetadata(principal, request));
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.content.manage'],
    scope: 'platform',
  })
  create(
    @Body() input: CreateStorageUploadIntentInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.createPlatformUploadIntent(
      input,
      platformMutationMetadata(principal, request),
    );
  }

  @Post(':mediaId/complete')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.content.manage'],
    scope: 'platform',
  })
  complete(
    @Param('mediaId') mediaId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.uploads.completePlatformUpload(
      mediaId,
      platformMutationMetadata(principal, request),
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
  requireIdempotencyKey: boolean,
): StorageMutationMetadata {
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

function platformMutationMetadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): StorageMutationMetadata {
  if (principal.scope !== 'platform' || principal.tenantId !== undefined) {
    throw new ForbiddenException('Platform principal is required');
  }
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
    throw new BadRequestException('Idempotency-Key is ambiguous');
  }
  return value;
}
