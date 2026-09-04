import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { CustomerPlaybackUrlService } from './customer-playback-url.service';
import { PlaybackService } from './playback.service';
import type { UpsertWatchProgressInput } from './playback.types';

@Controller('customer/playback')
export class PlaybackController {
  constructor(
    @Inject(PlaybackService)
    private readonly playback: PlaybackService,
    @Inject(CustomerPlaybackAccessService)
    private readonly playbackAccess: CustomerPlaybackAccessService,
    @Inject(CustomerPlaybackUrlService)
    private readonly playbackUrls: CustomerPlaybackUrlService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('episodes/:episodeId/url')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async playbackUrl(
    @Param('episodeId') episodeId: string,
    @Query('expiresInSeconds') expiresInSeconds: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.playbackUrls.issue(
      await this.principal(request),
      episodeId,
      expiresInSeconds,
      request.ip,
    );
  }

  @Get('episodes/:episodeId/tracks/:trackId/url')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async playbackTrackUrl(
    @Param('episodeId') episodeId: string,
    @Param('trackId') trackId: string,
    @Query('expiresInSeconds') expiresInSeconds: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.playbackUrls.issueTrack(
      await this.principal(request), episodeId, trackId, expiresInSeconds, request.ip,
    );
  }

  @Get('episodes/:episodeId/access')
  @PublicEndpoint()
  async access(
    @Param('episodeId') episodeId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.playbackAccess.getAccess(
      await this.principal(request),
      episodeId,
    );
  }

  @Put('progress')
  @PublicEndpoint()
  async upsertProgress(
    @Body() input: UpsertWatchProgressInput,
    @Req() request: FastifyRequest,
  ) {
    return this.playback.upsertProgress(await this.principal(request), input);
  }

  @Get('history')
  @PublicEndpoint()
  async history(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.playback.listHistory(
      await this.principal(request),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Get('favorites')
  @PublicEndpoint()
  async favorites(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.playback.listFavorites(
      await this.principal(request),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Post('favorites/:dramaId')
  @PublicEndpoint()
  async addFavorite(
    @Param('dramaId') dramaId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.playback.addFavorite(
      await this.principal(request),
      dramaId,
      uuidV7(),
    );
  }

  @Delete('favorites/:dramaId')
  @PublicEndpoint()
  async removeFavorite(
    @Param('dramaId') dramaId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.playback.removeFavorite(
      await this.principal(request),
      dramaId,
      uuidV7(),
    );
  }

  private async principal(request: FastifyRequest) {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') {
      throw new ForbiddenException('Tenant is not available');
    }
    return this.authentication.authenticateAccess(
      context.tenantId,
      bearerToken(request),
    );
  }
}
