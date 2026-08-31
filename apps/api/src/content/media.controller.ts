import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import type { ContentMutationMetadata } from './content.types';
import { MediaService } from './media.service';

@Controller('tenant/content/media')
export class TenantMediaController {
  constructor(
    @Inject(MediaService)
    private readonly media: MediaService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.drama.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.media.listTenant(
      requireTenantId(principal),
      query.kind,
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Post('external')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.create'],
    scope: 'tenant',
  })
  registerExternal(
    @Body() input: Parameters<MediaService['registerExternal']>[1],
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.media.registerExternal(
      requireTenantId(principal),
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
): ContentMutationMetadata {
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
