import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
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
import { AppBuildService } from './app-build.service';
import { AppBuildDownloadService } from './app-build-download.service';
import {
  AppBuildAssetService,
  type CreateAppBuildAssetInput,
} from './app-build-asset.service';
import type {
  AppBuildMutationMetadata,
  CreateAppBuildJobInput,
  UpsertAppBuildProfileInput,
} from './app-build.types';

@Controller('platform/merchants/:tenantId/app-builds')
export class AppBuildController {
  constructor(
    @Inject(AppBuildService)
    private readonly builds: AppBuildService,
    @Inject(AppBuildDownloadService)
    private readonly downloads: AppBuildDownloadService,
    @Inject(AppBuildAssetService)
    private readonly assets: AppBuildAssetService,
  ) {}

  @Get('prerequisites')
  @RequirePermissions({ mode: 'read', permissions: ['platform.app_build.read'], scope: 'platform' })
  prerequisites(@Param('tenantId') tenantId: string) {
    return this.builds.getPrerequisites(tenantId);
  }

  @Get('profile')
  @RequirePermissions({ mode: 'read', permissions: ['platform.app_build.read'], scope: 'platform' })
  profile(@Param('tenantId') tenantId: string) {
    return this.builds.getProfile(tenantId);
  }

  @Put('profile')
  @RequirePermissions({ mode: 'write', permissions: ['platform.app_build.manage'], scope: 'platform' })
  upsertProfile(
    @Param('tenantId') tenantId: string,
    @Body() input: UpsertAppBuildProfileInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.builds.upsertProfile(tenantId, input, metadata(principal, request));
  }

  @Get('jobs')
  @RequirePermissions({ mode: 'read', permissions: ['platform.app_build.read'], scope: 'platform' })
  jobs(
    @Param('tenantId') tenantId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.builds.listJobs(tenantId, query);
  }

  @Get('jobs/:jobId')
  @RequirePermissions({ mode: 'read', permissions: ['platform.app_build.read'], scope: 'platform' })
  job(@Param('tenantId') tenantId: string, @Param('jobId') jobId: string) {
    return this.builds.getJob(tenantId, jobId);
  }

  @Post('jobs')
  @RequirePermissions({ mode: 'write', permissions: ['platform.app_build.manage'], scope: 'platform' })
  createJob(
    @Param('tenantId') tenantId: string,
    @Body() input: CreateAppBuildJobInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.builds.createJob(tenantId, input, metadata(principal, request));
  }

  @Post('jobs/:jobId/cancel')
  @RequirePermissions({ mode: 'write', permissions: ['platform.app_build.manage'], scope: 'platform' })
  cancelJob(
    @Param('tenantId') tenantId: string,
    @Param('jobId') jobId: string,
    @Body() input: { expectedVersion: number },
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.builds.cancelJob(tenantId, jobId, input, metadata(principal, request));
  }

  @Post('jobs/:jobId/download')
  @Header('Cache-Control', 'private, no-store, max-age=0')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.app_build.download'], scope: 'platform',
  })
  download(
    @Param('tenantId') tenantId: string,
    @Param('jobId') jobId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    assertPlatformPrincipal(principal);
    return this.downloads.issue(tenantId, jobId, {
      actorId: principal.subjectId,
      ip: request.ip,
      requestId: request.id || uuidV7(),
    });
  }

  @Post('assets/uploads')
  @RequirePermissions({ mode: 'write', permissions: ['platform.app_build.manage'], scope: 'platform' })
  createAssetUpload(
    @Param('tenantId') tenantId: string,
    @Body() input: CreateAppBuildAssetInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.assets.create(tenantId, input, metadata(principal, request));
  }

  @Post('assets/uploads/:mediaId/complete')
  @RequirePermissions({ mode: 'write', permissions: ['platform.app_build.manage'], scope: 'platform' })
  completeAssetUpload(
    @Param('tenantId') tenantId: string,
    @Param('mediaId') mediaId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.assets.complete(tenantId, mediaId, metadata(principal, request));
  }
}

function metadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): AppBuildMutationMetadata {
  assertPlatformPrincipal(principal);
  const key = singleHeader(request.headers['idempotency-key']);
  return {
    actorId: principal.subjectId,
    idempotencyKey: key,
    ip: request.ip,
    requestId: request.id || uuidV7(),
  };
}

function assertPlatformPrincipal(principal: AccessPrincipal): void {
  if (principal.scope !== 'platform' || principal.tenantId !== undefined) {
    throw new ForbiddenException('Platform principal is required');
  }
}

function singleHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value) || typeof value !== 'string'
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A single valid Idempotency-Key header is required');
  }
  return value.trim();
}
