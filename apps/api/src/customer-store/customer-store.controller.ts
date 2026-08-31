import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerStoreService, customerSiteUnavailable } from './customer-store.service';
import type {
  CustomerEntitlementQuery,
  CustomerPageQuery,
  CustomerStoreQuery,
} from './customer-store.types';

abstract class CustomerTenantController {
  protected constructor(
    protected readonly tenantContext: TenantContextService,
  ) {}

  protected verifiedTenantId(): string {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') throw customerSiteUnavailable();
    return context.tenantId;
  }
}

@Controller('customer')
export class CustomerBootstrapController extends CustomerTenantController {
  constructor(
    @Inject(CustomerStoreService)
    private readonly store: CustomerStoreService,
    @Inject(TenantContextService)
    tenantContext: TenantContextService,
  ) {
    super(tenantContext);
  }

  @Get('bootstrap')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  bootstrap(@Query() query: Record<string, unknown>) {
    return this.store.bootstrap(this.verifiedTenantId(), query);
  }
}

@Controller('customer/commerce')
export class CustomerStoreCatalogController extends CustomerTenantController {
  constructor(
    @Inject(CustomerStoreService)
    private readonly store: CustomerStoreService,
    @Inject(TenantContextService)
    tenantContext: TenantContextService,
  ) {
    super(tenantContext);
  }

  @Get('catalog')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  catalog(@Query() query: CustomerStoreQuery) {
    return this.store.commerceCatalog(this.verifiedTenantId(), query);
  }
}

@Controller('customer/content')
export class CustomerNavigationController extends CustomerTenantController {
  constructor(
    @Inject(CustomerStoreService)
    private readonly store: CustomerStoreService,
    @Inject(TenantContextService)
    tenantContext: TenantContextService,
  ) {
    super(tenantContext);
  }

  @Get('categories')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  categories(@Query() query: Record<string, unknown>) {
    return this.store.categories(this.verifiedTenantId(), query);
  }

  @Get('tags')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  tags(@Query() query: Record<string, unknown>) {
    return this.store.tags(this.verifiedTenantId(), query);
  }
}

@Controller('customer')
export class CustomerReadModelController extends CustomerTenantController {
  constructor(
    @Inject(CustomerStoreService)
    private readonly store: CustomerStoreService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    tenantContext: TenantContextService,
  ) {
    super(tenantContext);
  }

  @Get('account/me')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async account(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.store.accountMe(await this.principal(request), query);
  }

  @Get('wallet/points')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async wallet(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.store.pointWallet(await this.principal(request), query);
  }

  @Get('wallet/points/ledger')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async ledger(
    @Query() query: CustomerPageQuery,
    @Req() request: FastifyRequest,
  ) {
    return this.store.pointLedger(await this.principal(request), query);
  }

  @Get('entitlements')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async entitlements(
    @Query() query: CustomerEntitlementQuery,
    @Req() request: FastifyRequest,
  ) {
    return this.store.entitlements(await this.principal(request), query);
  }

  private async principal(request: FastifyRequest) {
    const tenantId = this.verifiedTenantId();
    const principal = await this.authentication.authenticateAccess(
      tenantId,
      bearerToken(request),
    );
    if (principal.tenantId !== tenantId) {
      throw new ForbiddenException('Customer tenant does not match the verified host');
    }
    return principal;
  }
}

