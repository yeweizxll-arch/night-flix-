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
import { ContentService } from './content.service';
import type {
  ContentMutationMetadata,
  CreateDramaInput,
  CreateEpisodeInput,
  DeleteTenantDramaInput,
  ExpectedTenantContentVersionInput,
  UpdateDramaInput,
  UpdateEpisodeInput,
} from './content.types';

@Controller('tenant/content/dramas')
export class TenantContentController {
  constructor(
    @Inject(ContentService)
    private readonly content: ContentService,
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
    return this.content.listTenantDramas(
      requireTenantId(principal),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
      query.deleted === 'true',
    );
  }

  @Post()
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.create'],
    scope: 'tenant',
  })
  create(
    @Body() input: CreateDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.createTenantDrama(
      requireTenantId(principal),
      input,
      mutationMetadata(principal, request),
    );
  }

  @Get(':dramaId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['content.drama.read'],
    scope: 'tenant',
  })
  detail(
    @Param('dramaId') dramaId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.content.getTenantDrama(requireTenantId(principal), dramaId);
  }

  @Patch(':dramaId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  update(
    @Param('dramaId') dramaId: string,
    @Body() input: UpdateDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.updateTenantDrama(
      requireTenantId(principal),
      dramaId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Post(':dramaId/episodes')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  addEpisode(
    @Param('dramaId') dramaId: string,
    @Body() input: CreateEpisodeInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.addTenantEpisode(
      requireTenantId(principal),
      dramaId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':dramaId/episodes/:episodeId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  updateEpisode(
    @Param('dramaId') dramaId: string,
    @Param('episodeId') episodeId: string,
    @Body() input: UpdateEpisodeInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.updateTenantEpisode(
      requireTenantId(principal),
      dramaId,
      episodeId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Post(':dramaId/publish')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  publish(
    @Param('dramaId') dramaId: string,
    @Body() input: ExpectedTenantContentVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.setTenantDramaPublication(
      requireTenantId(principal), dramaId, 'publish', input,
      mutationMetadata(principal, request),
    );
  }

  @Post(':dramaId/unpublish')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  unpublish(
    @Param('dramaId') dramaId: string,
    @Body() input: ExpectedTenantContentVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.setTenantDramaPublication(
      requireTenantId(principal), dramaId, 'unpublish', input,
      mutationMetadata(principal, request),
    );
  }

  @Post(':dramaId/withdraw-review')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.submit_review'],
    scope: 'tenant',
  })
  withdrawReview(
    @Param('dramaId') dramaId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.withdrawTenantReview(
      requireTenantId(principal),
      dramaId,
      mutationMetadata(principal, request),
    );
  }

  @Delete(':dramaId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  softDelete(
    @Param('dramaId') dramaId: string,
    @Body() body: DeleteTenantDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.softDeleteTenantDrama(
      requireTenantId(principal),
      dramaId,
      body,
      mutationMetadata(principal, request),
    );
  }

  @Post(':dramaId/restore')
  @RequirePermissions({
    mode: 'write',
    permissions: ['content.drama.update'],
    scope: 'tenant',
  })
  restore(
    @Param('dramaId') dramaId: string,
    @Body() body: ExpectedTenantContentVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.content.restoreTenantDrama(
      requireTenantId(principal),
      dramaId,
      body,
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
  const idempotencyKey = requiredSingleHeader(request.headers['idempotency-key']);
  return {
    actorId: principal.subjectId,
    idempotencyKey,
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function requiredSingleHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value) || typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException('A single Idempotency-Key header is required');
  }
  return value;
}
