import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { TenantContextService } from '../tenancy/tenant-context.service';
import type {
  CreateCustomerOtpInput,
  CustomerLoginInput,
  RegisterCustomerInput,
  ResetCustomerPasswordInput,
  VerifyCustomerOtpInput,
} from './customer-auth.types';
import { CustomerAuthenticationService } from './customer-authentication.service';
import { CustomerOtpService } from './customer-otp.service';

@Controller('customer/auth')
export class CustomerAuthenticationController {
  constructor(
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(CustomerOtpService)
    private readonly otp: CustomerOtpService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('identity/challenge')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  identityChallenge(@Body() input: { provider: 'apple' | 'google' }, @Req() request: FastifyRequest) {
    return this.authentication.identityChallenge(this.requireAvailableTenant(), input?.provider, requestMetadata(request));
  }

  @Post('identity/login')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  identityLogin(@Body() input: Parameters<CustomerAuthenticationService['identityLogin']>[1], @Req() request: FastifyRequest) {
    return this.authentication.identityLogin(this.requireAvailableTenant(), input, requestMetadata(request));
  }

  @Post('register')
  @PublicEndpoint()
  async register(
    @Body() input: RegisterCustomerInput,
    @Req() request: FastifyRequest,
  ) {
    const tenantId = this.requireAvailableTenant();
    return this.authentication.register(tenantId, input, requestMetadata(request));
  }

  @Post('otp/challenges')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async createOtp(
    @Body() input: CreateCustomerOtpInput,
    @Req() request: FastifyRequest,
  ) {
    return this.otp.createChallenge(
      this.requireAvailableTenant(),
      input,
      requestMetadata(request),
    );
  }

  @Post('otp/verify')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async verifyOtp(
    @Body() input: VerifyCustomerOtpInput,
    @Req() request: FastifyRequest,
  ) {
    return this.otp.verifyChallenge(
      this.requireAvailableTenant(),
      input,
      requestMetadata(request),
    );
  }

  @Post('login')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() input: CustomerLoginInput,
    @Req() request: FastifyRequest,
  ) {
    return this.authentication.login(
      this.requireAvailableTenant(),
      input,
      requestMetadata(request),
    );
  }

  @Post('refresh')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async refresh(
    @Body() body: { refreshToken?: unknown },
    @Req() request: FastifyRequest,
  ) {
    if (typeof body?.refreshToken !== 'string') {
      throw new BadRequestException('refreshToken is required');
    }
    return this.authentication.refresh(
      this.requireAvailableTenant(),
      body.refreshToken,
      requestMetadata(request),
    );
  }

  @Post('logout')
  @PublicEndpoint()
  @HttpCode(204)
  async logout(@Body() body: { refreshToken?: unknown }): Promise<void> {
    await this.authentication.logout(
      this.requireAvailableTenant(),
      typeof body?.refreshToken === 'string' ? body.refreshToken : undefined,
    );
  }

  @Post('password/reset')
  @PublicEndpoint()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async resetPassword(
    @Body() input: ResetCustomerPasswordInput,
    @Req() request: FastifyRequest,
  ) {
    return this.authentication.resetPassword(
      this.requireAvailableTenant(),
      input,
      requestMetadata(request),
    );
  }

  @Post('account/disable')
  @PublicEndpoint()
  @HttpCode(200)
  async disableOwnAccount(
    @Body() body: { reason?: unknown },
    @Req() request: FastifyRequest,
  ) {
    const tenantId = this.requireAvailableTenant();
    const principal = await this.authentication.authenticateAccessForAccountClosure(
      tenantId,
      bearerToken(request),
    );
    return this.authentication.disableOwnAccount(
      principal,
      body?.reason,
      requestMetadata(request),
    );
  }

  private requireAvailableTenant(): string {
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

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    throw new UnauthorizedException('Authorization header is required');
  }
  const match = /^Bearer (atk_[A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match?.[1]) throw new UnauthorizedException('Authorization header is invalid');
  return match[1];
}

export function requestMetadata(request: FastifyRequest) {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip,
    requestId: uuidV7(),
    userAgentHash: userAgent
      ? `sha256$${createHash('sha256').update(userAgent).digest('base64url')}`
      : undefined,
  };
}

export function oneIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new BadRequestException('Idempotency-Key header is ambiguous');
    return value[0] ?? '';
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  return value;
}
