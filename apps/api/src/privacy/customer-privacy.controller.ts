import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  RequirePermissions,
  type AccessPrincipal,
} from '../access-control';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import {
  bearerToken,
} from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerPrivacyService } from './customer-privacy.service';

@Controller('customer/privacy')
export class CustomerPrivacyController {
  constructor(
    @Inject(CustomerPrivacyService)
    private readonly privacy: CustomerPrivacyService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('consents')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async consents(@Req() request: FastifyRequest) {
    return this.privacy.listConsents(await this.principal(request));
  }

  @Post('export')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async exportData(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.privacy.exportData(
      await this.principal(request),
      input as never,
      { requestId: uuidV7() },
    );
  }

  @Post('erasure-requests')
  @PublicEndpoint()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async requestErasure(
    @Body() input: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.privacy.requestErasure(
      await this.principal(request),
      input as never,
      {
        idempotencyKey: oneHeader(request, 'idempotency-key'),
        ip: request.ip,
        requestId: uuidV7(),
      },
    );
  }

  private async principal(request: FastifyRequest) {
    const tenantId = this.verifiedTenantId();
    const principal = await this.authentication.authenticateAccessForAccountClosure(
      tenantId,
      bearerToken(request),
    );
    if (principal.tenantId !== tenantId) {
      throw new ForbiddenException('Customer tenant does not match the verified host');
    }
    return principal;
  }

  private verifiedTenantId(): string {
    const context = this.tenantContext.current();
    if (!context?.tenantId) throw new BadRequestException('A verified tenant domain is required');
    if (context.tenantStatus !== 'active') throw new ForbiddenException('Tenant is unavailable');
    return context.tenantId;
  }
}

@Controller('tenant/privacy/requests')
export class TenantPrivacyRequestController {
  constructor(
    @Inject(CustomerPrivacyService)
    private readonly privacy: CustomerPrivacyService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read', permissions: ['tenant.privacy_request.read'], scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.privacy.listTenantRequests(this.tenant(principal), query);
  }

  @Get(':requestId')
  @RequirePermissions({
    mode: 'read', permissions: ['tenant.privacy_request.read'], scope: 'tenant',
  })
  detail(
    @Param('requestId') requestId: string,
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    if (Object.keys(query).length > 0) throw new BadRequestException('Query is not supported');
    return this.privacy.tenantRequestDetail(this.tenant(principal), requestId);
  }

  private tenant(principal: AccessPrincipal): string {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId || principal.scope !== 'tenant' || principal.tenantId !== tenantId) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return tenantId;
  }
}

function oneHeader(request: FastifyRequest, name: 'idempotency-key'): unknown {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  return value;
}
