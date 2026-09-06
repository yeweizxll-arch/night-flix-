import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { HlsPlaybackService } from './hls-playback.service';

@Controller('customer/playback/hls')
export class HlsPlaybackController {
  constructor(
    @Inject(TenantContextService) private readonly context: TenantContextService,
    @Inject(HlsPlaybackService) private readonly hls: HlsPlaybackService,
  ) {}
  @Get('resource')
  @PublicEndpoint()
  async resource(@Query('token') token: unknown, @Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const tenant = this.context.current();
    if (!tenant?.tenantId) throw new BadRequestException('A verified tenant domain is required');
    if (tenant.tenantStatus !== 'active') throw new ForbiddenException('Tenant is not available');
    const result = await this.hls.read(token, tenant.tenantId, `https://${tenant.host}`, request.headers.range);
    reply.header('Cache-Control', 'private, no-store, max-age=0');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.type(result.contentType);
    if (result.contentRange) reply.code(206).header('Content-Range', result.contentRange);
    return reply.send(result.body);
  }
}
