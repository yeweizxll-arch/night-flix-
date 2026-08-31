import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { uuidV7 } from '../common/uuid-v7';
import { RefundService } from './refund.service';

@Controller('tenant/commerce')
export class TenantRefundController {
  constructor(
    @Inject(RefundService)
    private readonly refunds: RefundService,
  ) {}

  @Get('refunds')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.refund.read'], scope: 'tenant' })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.refunds.listTenantRefunds(tenantId(principal), query);
  }

  @Get('refunds/:refundId')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.refund.read'], scope: 'tenant' })
  detail(
    @Param('refundId') refundId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.refunds.getTenantRefund(tenantId(principal), refundId);
  }

  @Post('orders/:orderId/refunds')
  @RequirePermissions({ mode: 'write', permissions: ['commerce.refund.manage'], scope: 'tenant' })
  create(
    @Param('orderId') orderId: string,
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.refunds.createTenantRefund(
      tenantId(principal),
      principal.subjectId,
      orderId,
      input,
      idempotencyKey(request),
      uuidV7(),
    );
  }
}

@Controller('platform/finance')
export class PlatformRefundController {
  constructor(
    @Inject(RefundService)
    private readonly refunds: RefundService,
  ) {}

  @Get('refunds')
  @RequirePermissions({ mode: 'read', permissions: ['finance.refund.read'], scope: 'platform' })
  list(@Query() query: Record<string, unknown>) {
    return this.refunds.listPlatformRefunds(query);
  }

  @Get('refunds/:refundId')
  @RequirePermissions({ mode: 'read', permissions: ['finance.refund.read'], scope: 'platform' })
  detail(@Param('refundId') refundId: string) {
    return this.refunds.getPlatformRefund(refundId);
  }

  @Post('orders/:orderId/refunds')
  @RequirePermissions({ mode: 'write', permissions: ['finance.refund.manage'], scope: 'platform' })
  create(
    @Param('orderId') orderId: string,
    @Body() input: unknown,
    @Req() request: FastifyRequest,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.refunds.createPlatformRefund(
      principal.subjectId,
      orderId,
      input,
      idempotencyKey(request),
      uuidV7(),
    );
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  return value;
}
