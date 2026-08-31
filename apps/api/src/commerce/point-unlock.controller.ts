import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { PointUnlockService } from './point-unlock.service';

@Controller('customer/commerce/point-unlocks')
export class CustomerPointUnlockController {
  constructor(
    @Inject(PointUnlockService)
    private readonly unlocks: PointUnlockService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post(':targetType/:targetId')
  @PublicEndpoint()
  async unlock(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Body() input: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
  ) {
    const commandKey = singleHeader(idempotencyKey);
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') {
      throw new ForbiddenException('Tenant is not available');
    }
    return this.unlocks.unlock(
      await this.authentication.authenticateAccess(
        context.tenantId,
        bearerToken(request),
      ),
      targetType,
      targetId,
      input,
      commandKey,
      uuidV7(),
    );
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BadRequestException('Idempotency-Key header is ambiguous');
    }
    return value[0];
  }
  return value;
}
