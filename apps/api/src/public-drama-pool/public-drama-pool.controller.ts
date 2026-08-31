import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { PublicDramaPoolService } from './public-drama-pool.service';
import type {
  EmergencyTakedownInput,
  PublishPublicDramaInput,
  ReviewPublicDramaInput,
  TenantAppRuntimeConfigInput,
  UnpublishPublicDramaInput,
} from './public-drama-pool.types';

@Controller('tenant/public-drama-pool')
export class TenantPublicDramaPoolController {
  constructor(@Inject(PublicDramaPoolService) private readonly pool: PublicDramaPoolService) {}

  @Get()
  @RequirePermissions({ mode: 'read', permissions: ['content.drama.read'], scope: 'tenant' })
  list(@Query() query: Record<string, unknown>, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.pool.listPool(tenantId(principal), query.page, query.pageSize);
  }

  @Post(':dramaId/review')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.submit_review'], scope: 'tenant' })
  review(@Param('dramaId') dramaId: string, @Body() input: ReviewPublicDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.pool.review(tenantId(principal), dramaId, input, metadata(principal, request));
  }

  @Post(':dramaId/publish')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  publish(@Param('dramaId') dramaId: string, @Body() input: PublishPublicDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.pool.publish(tenantId(principal), dramaId, input, metadata(principal, request));
  }

  @Post(':dramaId/unpublish')
  @RequirePermissions({ mode: 'write', permissions: ['content.drama.update'], scope: 'tenant' })
  unpublish(@Param('dramaId') dramaId: string, @Body() input: UnpublishPublicDramaInput,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.pool.unpublish(tenantId(principal), dramaId, input, metadata(principal, request));
  }
}

@Controller('tenant/app-runtime-config')
export class TenantAppRuntimeConfigController {
  constructor(@Inject(PublicDramaPoolService) private readonly pool: PublicDramaPoolService) {}

  @Get()
  @RequirePermissions({ mode: 'read', permissions: ['tenant.site.read'], scope: 'tenant' })
  get(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.pool.getRuntimeConfig(tenantId(principal));
  }

  @Put()
  @RequirePermissions({ mode: 'write', permissions: ['tenant.site.manage'], scope: 'tenant' })
  update(@Body() input: TenantAppRuntimeConfigInput,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.pool.updateRuntimeConfig(tenantId(principal), input, metadata(principal, request));
  }
}

@Controller('platform/public-drama-pool')
export class PlatformPublicDramaPoolController {
  constructor(@Inject(PublicDramaPoolService) private readonly pool: PublicDramaPoolService) {}

  @Post(':dramaId/emergency-takedown')
  @RequirePermissions({ mode: 'write', permissions: ['platform.content.publish'], scope: 'platform' })
  emergencyTakedown(@Param('dramaId') dramaId: string, @Body() input: EmergencyTakedownInput,
    @CurrentPrincipal() principal: AccessPrincipal, @Req() request: FastifyRequest) {
    return this.pool.emergencyTakedown(dramaId, input, metadata(principal, request));
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function metadata(principal: AccessPrincipal, request: FastifyRequest) {
  return { actorId: principal.subjectId, ip: request.ip, requestId: uuidV7() };
}
