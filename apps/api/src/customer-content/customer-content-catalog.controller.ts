import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerContentCatalogService } from './customer-content-catalog.service';
import type { CustomerDramaCatalogQuery } from './customer-content-catalog.types';

@Controller('customer/content')
export class CustomerContentCatalogController {
  constructor(
    @Inject(CustomerContentCatalogService)
    private readonly catalog: CustomerContentCatalogService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
  ) {}

  @Get('dramas')
  @PublicEndpoint()
  async list(@Query() query: CustomerDramaCatalogQuery, @Req() request?: FastifyRequest) {
    const tenantId = this.verifiedTenantId();
    if (request?.headers.authorization !== undefined) {
      const principal = await this.authentication.authenticateAccess(tenantId, bearerToken(request));
      return this.catalog.listDramas(tenantId, query, principal.accountId);
    }
    return this.catalog.listDramas(tenantId, query);
  }

  @Get('dramas/:dramaId')
  @PublicEndpoint()
  async detail(
    @Param('dramaId') dramaId: string,
    @Query('locale') locale: unknown,
    @Req() request: FastifyRequest,
  ) {
    const tenantId = this.verifiedTenantId();
    const principal = request.headers.authorization !== undefined
      ? await this.authentication.authenticateAccess(tenantId, bearerToken(request))
      : undefined;
    return this.catalog.getDrama(tenantId, dramaId, locale, principal?.accountId);
  }

  private verifiedTenantId(): string {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') {
      throw new ForbiddenException('Tenant is not available');
    }
    return context.tenantId;
  }
}
