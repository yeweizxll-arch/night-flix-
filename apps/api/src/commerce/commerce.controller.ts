import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Patch,
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
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CommerceCatalogService } from './commerce-catalog.service';
import { CommerceOrderService } from './commerce-order.service';
import type {
  CommerceOrderInput,
  CreateMembershipPlanInput,
  CreatePointsTopupPackageInput,
  ReplaceCatalogTranslationsInput,
  UpsertContentPriceInput,
  UpsertContentPointPriceInput,
  UpsertPriceInput,
  UpdateCatalogStatusInput,
} from './commerce.types';

@Controller('tenant/commerce/catalog')
export class TenantCommerceCatalogController {
  constructor(
    @Inject(CommerceCatalogService)
    private readonly catalog: CommerceCatalogService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.catalog.read'],
    scope: 'tenant',
  })
  list(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.catalog.listTenantCatalog(requireStaffTenantId(principal));
  }

  @Post('membership-plans')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  createMembershipPlan(
    @Body() input: CreateMembershipPlanInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.createMembershipPlan(
      requireStaffTenantId(principal),
      input,
      staffMetadata(principal, request),
    );
  }

  @Patch('membership-plans/:planId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  updateMembershipPlanStatus(
    @Param('planId') planId: string,
    @Body() input: UpdateCatalogStatusInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.updateMembershipPlanStatus(
      requireStaffTenantId(principal),
      planId,
      input,
      staffMetadata(principal, request),
    );
  }

  @Put('membership-plans/:planId/prices/:currency')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  upsertMembershipPrice(
    @Param('planId') planId: string,
    @Param('currency') currency: string,
    @Body() input: Omit<UpsertPriceInput, 'currency'>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.upsertMembershipPlanPrice(
      requireStaffTenantId(principal),
      planId,
      { ...input, currency: currency as UpsertPriceInput['currency'] },
      staffMetadata(principal, request),
    );
  }

  @Put('membership-plans/:planId/translations')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  replaceMembershipTranslations(
    @Param('planId') planId: string,
    @Body() input: ReplaceCatalogTranslationsInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.replaceMembershipPlanTranslations(
      requireStaffTenantId(principal),
      planId,
      input,
      staffMetadata(principal, request),
    );
  }

  @Put('content-prices/:targetType/:targetId/:currency')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  upsertContentPrice(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Param('currency') currency: string,
    @Body() input: Pick<UpsertContentPriceInput, 'amountMinor' | 'status'>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.upsertContentPrice(
      requireStaffTenantId(principal),
      {
        ...input,
        currency: currency as UpsertContentPriceInput['currency'],
        targetId,
        targetType: targetType as UpsertContentPriceInput['targetType'],
      },
      staffMetadata(principal, request),
    );
  }

  @Put('content-point-prices/:targetType/:targetId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  upsertContentPointPrice(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Body() input: Pick<UpsertContentPointPriceInput, 'pointsAmount' | 'status' | 'version'>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.upsertContentPointPrice(
      requireStaffTenantId(principal),
      {
        ...input,
        targetId,
        targetType: targetType as UpsertContentPointPriceInput['targetType'],
      },
      staffMetadata(principal, request),
    );
  }

  @Post('points-topup-packages')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  createPointsTopupPackage(
    @Body() input: CreatePointsTopupPackageInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.createPointsTopupPackage(
      requireStaffTenantId(principal),
      input,
      staffMetadata(principal, request),
    );
  }

  @Patch('points-topup-packages/:packageId/status')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  updatePointsTopupPackageStatus(
    @Param('packageId') packageId: string,
    @Body() input: UpdateCatalogStatusInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.updatePointsTopupPackageStatus(
      requireStaffTenantId(principal),
      packageId,
      input,
      staffMetadata(principal, request),
    );
  }

  @Put('points-topup-packages/:packageId/prices/:currency')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  upsertPointsPrice(
    @Param('packageId') packageId: string,
    @Param('currency') currency: string,
    @Body() input: Omit<UpsertPriceInput, 'currency'>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.upsertPointsTopupPackagePrice(
      requireStaffTenantId(principal),
      packageId,
      { ...input, currency: currency as UpsertPriceInput['currency'] },
      staffMetadata(principal, request),
    );
  }

  @Put('points-topup-packages/:packageId/translations')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.catalog.manage'],
    scope: 'tenant',
  })
  replacePointsTranslations(
    @Param('packageId') packageId: string,
    @Body() input: ReplaceCatalogTranslationsInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.catalog.replacePointsTopupPackageTranslations(
      requireStaffTenantId(principal),
      packageId,
      input,
      staffMetadata(principal, request),
    );
  }
}

@Controller('tenant/commerce/orders')
export class TenantCommerceOrderController {
  constructor(
    @Inject(CommerceOrderService)
    private readonly orders: CommerceOrderService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.order.read'],
    scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.orders.listTenantOrders(requireStaffTenantId(principal), {
      orderType: query.orderType,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
    });
  }

  @Get(':orderId')
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.order.read'],
    scope: 'tenant',
  })
  get(
    @Param('orderId') orderId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.orders.getTenantOrder(requireStaffTenantId(principal), orderId);
  }
}

@Controller('customer/commerce')
export class CustomerCommerceController {
  constructor(
    @Inject(CommerceOrderService)
    private readonly orders: CommerceOrderService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('quote')
  @PublicEndpoint()
  async quote(
    @Body() input: CommerceOrderInput,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.quote(await this.customerPrincipal(request), input);
  }

  @Post('orders')
  @PublicEndpoint()
  async createOrder(
    @Body() input: CommerceOrderInput,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = headerValue(request.headers['idempotency-key']);
    return this.orders.createOrder(
      await this.customerPrincipal(request),
      input,
      {
        idempotencyKey,
        ip: request.ip,
        requestId: uuidV7(),
      },
    );
  }

  @Get('orders')
  @PublicEndpoint()
  async listOrders(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.listOrders(
      await this.customerPrincipal(request),
      Number(query.page ?? 1),
      Number(query.pageSize ?? 20),
    );
  }

  @Get('orders/:orderId')
  @PublicEndpoint()
  async getOrder(
    @Param('orderId') orderId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.orders.getOrder(await this.customerPrincipal(request), orderId);
  }

  private async customerPrincipal(request: FastifyRequest) {
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

function requireStaffTenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function staffMetadata(principal: AccessPrincipal, request: FastifyRequest) {
  return {
    actorId: principal.subjectId,
    requestId: uuidV7(),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BadRequestException('Idempotency-Key header is ambiguous');
    }
    return value[0];
  }
  return value;
}
