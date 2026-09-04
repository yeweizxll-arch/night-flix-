import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { PlatformContentLibraryService } from './platform-content-library.service';
import type {
  CreatePlatformDramaInput,
  CreatePlatformEpisodeInput,
  CreatePlatformTaxonomyInput,
  DeletePlatformContentInput,
  ExpectedVersionInput,
  PlatformContentMutationMetadata,
  UpdatePlatformDramaInput,
  UpdatePlatformEpisodeInput,
  UpsertPlatformEpisodeTrackInput,
  UpdatePlatformTaxonomyInput,
} from './platform-content-library.types';

@Controller('platform/content-management')
export class PlatformContentLibraryController {
  constructor(
    @Inject(PlatformContentLibraryService)
    private readonly library: PlatformContentLibraryService,
  ) {}

  @Get('dramas')
  @RequirePermissions({ mode: 'read', permissions: ['platform.content.read'], scope: 'platform' })
  listDramas(@Query() query: Record<string, unknown>) {
    return this.library.listDramas(query);
  }

  @Get('dramas/:dramaId')
  @RequirePermissions({ mode: 'read', permissions: ['platform.content.read'], scope: 'platform' })
  dramaDetail(@Param('dramaId') dramaId: string) {
    return this.library.getDrama(dramaId);
  }

  @Post('dramas')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  createDrama(
    @Body() input: CreatePlatformDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.createDrama(input, mutationMetadata(principal, request));
  }

  @Patch('dramas/:dramaId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  updateDrama(
    @Param('dramaId') dramaId: string,
    @Body() input: UpdatePlatformDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.updateDrama(dramaId, input, mutationMetadata(principal, request));
  }

  @Post('dramas/:dramaId/episodes')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  addEpisode(
    @Param('dramaId') dramaId: string,
    @Body() input: CreatePlatformEpisodeInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.addEpisode(dramaId, input, mutationMetadata(principal, request));
  }

  @Patch('dramas/:dramaId/episodes/:episodeId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  updateEpisode(
    @Param('dramaId') dramaId: string,
    @Param('episodeId') episodeId: string,
    @Body() input: UpdatePlatformEpisodeInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.updateEpisode(
      dramaId,
      episodeId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Post('dramas/:dramaId/episodes/:episodeId/tracks')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  upsertEpisodeTrack(
    @Param('dramaId') dramaId: string,
    @Param('episodeId') episodeId: string,
    @Body() input: UpsertPlatformEpisodeTrackInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.upsertEpisodeTrack(
      dramaId, episodeId, input, mutationMetadata(principal, request),
    );
  }

  @Delete('dramas/:dramaId/episodes/:episodeId/tracks/:trackId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  disableEpisodeTrack(
    @Param('dramaId') dramaId: string,
    @Param('episodeId') episodeId: string,
    @Param('trackId') trackId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.disableEpisodeTrack(
      dramaId, episodeId, trackId, input, mutationMetadata(principal, request),
    );
  }

  @Post('dramas/:dramaId/publish')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.publish'], scope: 'platform' })
  publishDrama(
    @Param('dramaId') dramaId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.publishDrama(dramaId, input, mutationMetadata(principal, request));
  }

  @Post('dramas/:dramaId/unpublish')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.publish'], scope: 'platform' })
  unpublishDrama(
    @Param('dramaId') dramaId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.unpublishDrama(dramaId, input, mutationMetadata(principal, request));
  }

  @Delete('dramas/:dramaId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  deleteDrama(
    @Param('dramaId') dramaId: string,
    @Body() input: DeletePlatformContentInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.deleteDrama(dramaId, input, mutationMetadata(principal, request));
  }

  @Post('dramas/:dramaId/restore')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  restoreDrama(
    @Param('dramaId') dramaId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.restoreDrama(dramaId, input, mutationMetadata(principal, request));
  }

  @Get('categories')
  @RequirePermissions({ mode: 'read', permissions: ['platform.content.read'], scope: 'platform' })
  listCategories(@Query() query: Record<string, unknown>) {
    return this.library.listTaxonomy('category', query);
  }

  @Post('categories')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  createCategory(
    @Body() input: CreatePlatformTaxonomyInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.createTaxonomy('category', input, mutationMetadata(principal, request));
  }

  @Patch('categories/:categoryId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  updateCategory(
    @Param('categoryId') categoryId: string,
    @Body() input: UpdatePlatformTaxonomyInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.updateTaxonomy(
      'category', categoryId, input, mutationMetadata(principal, request),
    );
  }

  @Delete('categories/:categoryId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  deleteCategory(
    @Param('categoryId') categoryId: string,
    @Body() input: DeletePlatformContentInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.deleteTaxonomy(
      'category', categoryId, input, mutationMetadata(principal, request),
    );
  }

  @Post('categories/:categoryId/restore')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  restoreCategory(
    @Param('categoryId') categoryId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.restoreTaxonomy(
      'category', categoryId, input, mutationMetadata(principal, request),
    );
  }

  @Get('tags')
  @RequirePermissions({ mode: 'read', permissions: ['platform.content.read'], scope: 'platform' })
  listTags(@Query() query: Record<string, unknown>) {
    return this.library.listTaxonomy('tag', query);
  }

  @Post('tags')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  createTag(
    @Body() input: CreatePlatformTaxonomyInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.createTaxonomy('tag', input, mutationMetadata(principal, request));
  }

  @Patch('tags/:tagId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  updateTag(
    @Param('tagId') tagId: string,
    @Body() input: UpdatePlatformTaxonomyInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.updateTaxonomy('tag', tagId, input, mutationMetadata(principal, request));
  }

  @Delete('tags/:tagId')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  deleteTag(
    @Param('tagId') tagId: string,
    @Body() input: DeletePlatformContentInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.deleteTaxonomy('tag', tagId, input, mutationMetadata(principal, request));
  }

  @Post('tags/:tagId/restore')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.manage'], scope: 'platform' })
  restoreTag(
    @Param('tagId') tagId: string,
    @Body() input: ExpectedVersionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.library.restoreTaxonomy('tag', tagId, input, mutationMetadata(principal, request));
  }
}

function mutationMetadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): PlatformContentMutationMetadata {
  if (principal.scope !== 'platform' || principal.tenantId !== undefined) {
    throw new ForbiddenException('Platform principal is required');
  }
  const idempotencyKey = singleHeader(request.headers['idempotency-key']);
  if (!idempotencyKey) throw new BadRequestException('Idempotency-Key is required');
  return {
    actorId: principal.subjectId,
    idempotencyKey,
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key is ambiguous');
  }
  return value;
}
