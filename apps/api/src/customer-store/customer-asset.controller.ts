import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerAssetService } from './customer-asset.service';
import { customerSiteUnavailable } from './customer-store.service';

@Controller('customer/assets')
export class CustomerAssetController {
  constructor(
    @Inject(CustomerAssetService)
    private readonly assets: CustomerAssetService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get(':mediaId/url')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  issue(
    @Param('mediaId') mediaId: string,
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') throw customerSiteUnavailable();
    return this.assets.issue(context.tenantId, mediaId, query, request.ip);
  }
}

