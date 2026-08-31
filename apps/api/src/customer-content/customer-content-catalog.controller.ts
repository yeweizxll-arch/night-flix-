import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Query,
} from '@nestjs/common';

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
  ) {}

  @Get('dramas')
  @PublicEndpoint()
  list(@Query() query: CustomerDramaCatalogQuery) {
    return this.catalog.listDramas(this.verifiedTenantId(), query);
  }

  @Get('dramas/:dramaId')
  @PublicEndpoint()
  detail(
    @Param('dramaId') dramaId: string,
    @Query('locale') locale: unknown,
  ) {
    return this.catalog.getDrama(this.verifiedTenantId(), dramaId, locale);
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
