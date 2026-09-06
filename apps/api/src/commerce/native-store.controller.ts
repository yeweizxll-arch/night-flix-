import { BadRequestException, Body, Controller, Get, Header, Inject, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { AuthenticationRateLimiterService } from '../auth/authentication-rate-limiter.service';
import { CurrentPrincipal, RequirePermissions, type AccessPrincipal } from '../access-control';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { NativeStoreService } from './native-store.service';
import type { NativeStore } from './native-store-config';

@Controller('customer/native-store')
export class CustomerNativeStoreController {
  constructor(@Inject(NativeStoreService) private readonly store: NativeStoreService,
    @Inject(CustomerAuthenticationService) private readonly auth: CustomerAuthenticationService,
    @Inject(AuthenticationRateLimiterService) private readonly rateLimiter: AuthenticationRateLimiterService,
    @Inject(TenantContextService) private readonly context: TenantContextService) {}
  @Post('prepare') @PublicEndpoint() @Header('Cache-Control', 'no-store')
  async prepare(@Req() request: FastifyRequest, @Body() body?: { store: NativeStore; productId: string }) {
    return this.store.prepare(await this.principal(request), body);
  }
  @Post('verify') @PublicEndpoint() @Header('Cache-Control', 'no-store')
  async verify(@Body() body: { store: NativeStore; productId: string; receipt: string }, @Req() request: FastifyRequest) {
    const principal = await this.principal(request);
    await this.rateLimiter.consume({ operation: 'store_verify', scope: 'tenant', tenantId: principal.tenantId, login: principal.accountId, ip: request.ip });
    return this.store.verify(principal, body);
  }
  @Get('transactions') @PublicEndpoint() @Header('Cache-Control', 'no-store')
  async list(@Req() request: FastifyRequest) {
    const principal = await this.principal(request);
    return { items: await this.store.list(principal.tenantId, principal.accountId) };
  }
  private principal(request: FastifyRequest) {
    const context = this.context.current();
    if (!context?.tenantId || context.tenantStatus !== 'active') throw new UnauthorizedException('Tenant unavailable');
    return this.auth.authenticateAccess(context.tenantId, bearerToken(request));
  }
}

@Controller('payments/webhooks/native')
export class NativeStoreWebhookController {
  constructor(@Inject(NativeStoreService) private readonly store: NativeStoreService) {}
  @Post('apple/:tenantId') @PublicEndpoint()
  apple(@Param('tenantId') tenantId: string, @Body() body: { signedPayload: string }) {
    if (!body?.signedPayload) throw new BadRequestException('Signed notification required');
    return this.store.appleNotification(tenantId, body.signedPayload);
  }
  @Post('google/:tenantId') @PublicEndpoint()
  google(@Param('tenantId') tenantId: string, @Req() request: FastifyRequest, @Body() body: { message?: { data?: string } }) {
    return this.store.googleNotification(tenantId, request.headers.authorization ?? '', body);
  }
}

@Controller('tenant/commerce/native-store')
export class TenantNativeStoreController {
  constructor(@Inject(NativeStoreService) private readonly store: NativeStoreService) {}
  @Get('transactions')
  @RequirePermissions({ mode: 'read', permissions: ['commerce.order.read'], scope: 'tenant' })
  async list(@CurrentPrincipal() principal: AccessPrincipal) {
    if (!principal.tenantId) throw new UnauthorizedException();
    return { items: await this.store.list(principal.tenantId) };
  }
}
