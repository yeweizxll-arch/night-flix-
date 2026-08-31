import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import type { ContentMutationMetadata } from './content.types';
import { TenantContentPortabilityService } from './tenant-content-portability.service';

@Controller('tenant/content')
export class TenantContentPortabilityController {
  constructor(
    @Inject(TenantContentPortabilityService)
    private readonly portability: TenantContentPortabilityService,
  ) {}

  @Post('imports')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.create'], scope: 'tenant' })
  createImport(@Body() body: unknown, @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest) {
    return this.portability.createImport(tenantId(principal), body, mutationMetadata(principal, request));
  }

  @Get('imports')
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  listImports(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.portability.listImports(tenantId(principal), query);
  }

  @Get('imports/:jobId')
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  importDetail(@Param('jobId') jobId: string, @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal) {
    return this.portability.getImport(tenantId(principal), jobId, query);
  }

  @Get('export')
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  export(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest) {
    return this.portability.exportContent(tenantId(principal), query, {
      actorId: principal.subjectId, ip: request.ip, requestId: uuidV7(),
    });
  }
}

function tenantId(principal: AccessPrincipal) {
  if (principal.scope !== 'tenant' || !principal.tenantId) throw new BadRequestException('Tenant context required');
  return principal.tenantId;
}
function mutationMetadata(principal: AccessPrincipal, request: FastifyRequest): ContentMutationMetadata {
  const header = request.headers['idempotency-key'];
  if (Array.isArray(header) || typeof header !== 'string' || !header.trim()) {
    throw new BadRequestException('A single Idempotency-Key header is required');
  }
  return { actorId: principal.subjectId, idempotencyKey: header,
    ip: request.ip, requestId: uuidV7() };
}
