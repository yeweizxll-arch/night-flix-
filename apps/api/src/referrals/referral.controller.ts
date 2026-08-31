import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Post,
  Put,
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
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { ReferralService } from './referral.service';

@Controller('customer/referrals')
export class CustomerReferralController {
  constructor(
    @Inject(ReferralService)
    private readonly referrals: ReferralService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('me')
  @PublicEndpoint()
  async me(@Req() request: FastifyRequest) {
    return this.referrals.getCustomerSummary(await this.principal(request));
  }

  @Get('ledger')
  @PublicEndpoint()
  async ledger(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.referrals.listCustomerLedger(await this.principal(request), query);
  }

  @Post('invite-code')
  @PublicEndpoint()
  async createInviteCode(
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const commandKey = singleHeader(idempotencyKey);
    return this.referrals.createInviteCode(
      await this.principal(request),
      commandKey,
      uuidV7(),
    );
  }

  @Post('bind')
  @PublicEndpoint()
  async bind(
    @Body() input: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const commandKey = singleHeader(idempotencyKey);
    return this.referrals.bindReferral(
      await this.principal(request),
      input,
      commandKey,
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

@Controller('tenant/referrals')
export class TenantReferralController {
  constructor(
    @Inject(ReferralService)
    private readonly referrals: ReferralService,
  ) {}

  @Get('config')
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.referral.read'],
    scope: 'tenant',
  })
  config(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.referrals.getTenantConfig(tenantId(principal));
  }

  @Put('config')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.referral.manage'],
    scope: 'tenant',
  })
  updateConfig(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.referrals.upsertTenantConfig(
      tenantId(principal),
      principal.subjectId,
      input,
      uuidV7(),
    );
  }

  @Get('commissions')
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.referral.read'],
    scope: 'tenant',
  })
  commissions(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.referrals.listTenantCommissions(tenantId(principal), query);
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  return value;
}
