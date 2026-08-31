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

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import type { ContentMutationMetadata } from './content.types';
import { TenantContentTaxonomyService } from './tenant-content-taxonomy.service';

@Controller('tenant/content')
export class TenantContentTaxonomyController {
  constructor(
    @Inject(TenantContentTaxonomyService)
    private readonly taxonomy: TenantContentTaxonomyService,
  ) {}

  @Get('categories')
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  categories(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.taxonomy.list(tenantId(principal), 'category', query);
  }

  @Post('categories')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  createCategory(@Body() body: unknown, @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest) {
    return this.taxonomy.create(tenantId(principal), 'category', body, metadata(principal, request));
  }

  @Patch('categories/:id')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  updateCategory(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.update(tenantId(principal), 'category', id, body, metadata(principal, request));
  }

  @Delete('categories/:id')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  deleteCategory(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.remove(tenantId(principal), 'category', id, body, metadata(principal, request));
  }

  @Post('categories/:id/restore')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  restoreCategory(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.restore(tenantId(principal), 'category', id, body, metadata(principal, request));
  }

  @Get('tags')
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  tags(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.taxonomy.list(tenantId(principal), 'tag', query);
  }

  @Post('tags')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  createTag(@Body() body: unknown, @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest) {
    return this.taxonomy.create(tenantId(principal), 'tag', body, metadata(principal, request));
  }

  @Patch('tags/:id')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  updateTag(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.update(tenantId(principal), 'tag', id, body, metadata(principal, request));
  }

  @Delete('tags/:id')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  deleteTag(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.remove(tenantId(principal), 'tag', id, body, metadata(principal, request));
  }

  @Post('tags/:id/restore')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  restoreTag(@Param('id') id: string, @Body() body: unknown,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.taxonomy.restore(tenantId(principal), 'tag', id, body, metadata(principal, request));
  }
}

function tenantId(principal: AccessPrincipal) {
  if (principal.scope !== 'tenant' || !principal.tenantId) throw new BadRequestException('Tenant context required');
  return principal.tenantId;
}
function metadata(principal: AccessPrincipal, request: FastifyRequest): ContentMutationMetadata {
  const header = request.headers['idempotency-key'];
  if (Array.isArray(header) || typeof header !== 'string' || !header.trim()) {
    throw new BadRequestException('A single Idempotency-Key header is required');
  }
  return { actorId: principal.subjectId, idempotencyKey: header,
    ip: request.ip, requestId: uuidV7() };
}
