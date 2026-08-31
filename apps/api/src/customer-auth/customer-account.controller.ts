import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { TenantContextService } from '../tenancy/tenant-context.service';
import type { ChangeCustomerPasswordInput, CustomerPrincipal } from './customer-auth.types';
import {
  bearerToken,
  oneIdempotencyKey,
  requestMetadata,
} from './customer-authentication.controller';
import { CustomerAuthenticationService } from './customer-authentication.service';

@Controller('customer/account')
export class CustomerAccountController {
  constructor(
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('devices')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async devices(@Req() request: FastifyRequest) {
    return this.authentication.listDevices(await this.principal(request));
  }

  @Post('devices/:deviceId/revoke')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async revokeDevice(
    @Param('deviceId') deviceId: string,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.authentication.revokeDevice(principal, deviceId, {
      ...requestMetadata(request),
      idempotencyKey,
    });
  }

  @Post('password/change')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async changePassword(
    @Body() input: ChangeCustomerPasswordInput,
    @Req() request: FastifyRequest,
  ) {
    return this.authentication.changePassword(
      await this.principal(request),
      input,
      requestMetadata(request),
    );
  }

  private async principal(request: FastifyRequest): Promise<CustomerPrincipal> {
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
