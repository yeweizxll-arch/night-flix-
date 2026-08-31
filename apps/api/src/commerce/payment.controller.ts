import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  RawBody,
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
import { PaymentConfigurationService } from './payment-configuration.service';
import { PaymentCoreService } from './payment-core.service';
import { StripePaymentConfigurationService } from './stripe-payment-configuration.service';

@Controller('platform/payments/configs')
export class PlatformPaymentConfigurationController {
  constructor(
    @Inject(PaymentConfigurationService)
    private readonly configurations: PaymentConfigurationService,
    @Optional()
    @Inject(StripePaymentConfigurationService)
    private readonly stripeConfigurations?: StripePaymentConfigurationService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read',
    permissions: ['platform.payment.read'],
    scope: 'platform',
  })
  list() {
    return this.configurations.listPlatformPaymentConfigs();
  }

  @Post('fake')
  @RequirePermissions({
    mode: 'write',
    permissions: ['platform.payment.manage'],
    scope: 'platform',
  })
  createFake(
    @Body() input: { credentials?: unknown; label: string; providerCode?: 'fake' },
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.configurations.createPlatformFakeConfig(
      input,
      principal.subjectId,
      uuidV7(),
      requireIdempotencyKey(request),
    );
  }

  @Post('stripe')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.payment.manage'], scope: 'platform',
  })
  createStripe(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.createPlatform(
      principal.subjectId, input, requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Put(':configId/stripe/credentials')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.payment.manage'], scope: 'platform',
  })
  rotateStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.rotatePlatform(
      principal.subjectId, configId, input, requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post(':configId/stripe/test')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.payment.manage'], scope: 'platform',
  })
  testStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.testPlatform(
      principal.subjectId, configId, input, requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post(':configId/stripe/enable')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.payment.manage'], scope: 'platform',
  })
  enableStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.setPlatformStatus(
      principal.subjectId, configId, true, input, requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post(':configId/stripe/disable')
  @RequirePermissions({
    mode: 'write', permissions: ['platform.payment.manage'], scope: 'platform',
  })
  disableStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.setPlatformStatus(
      principal.subjectId, configId, false, input, requireIdempotencyKey(request), uuidV7(),
    );
  }
}

@Controller('tenant/commerce/payments')
export class TenantPaymentConfigurationController {
  constructor(
    @Inject(PaymentConfigurationService)
    private readonly configurations: PaymentConfigurationService,
    @Optional()
    @Inject(StripePaymentConfigurationService)
    private readonly stripeConfigurations?: StripePaymentConfigurationService,
  ) {}

  @Get('configs')
  @RequirePermissions({
    mode: 'read',
    permissions: ['commerce.payment.read'],
    scope: 'tenant',
  })
  list(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.configurations.listTenantPaymentConfigs(requireTenantId(principal));
  }

  @Post('configs/fake')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.payment.manage'],
    scope: 'tenant',
  })
  createFake(
    @Body() input: { credentials?: unknown; label: string; providerCode?: 'fake' },
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.configurations.createTenantFakeConfig(
      requireTenantId(principal),
      input,
      principal.subjectId,
      uuidV7(),
      requireIdempotencyKey(request),
    );
  }

  @Post('configs/stripe')
  @RequirePermissions({
    mode: 'write', permissions: ['commerce.payment.manage'], scope: 'tenant',
  })
  createStripe(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.createTenant(
      requireTenantId(principal), principal.subjectId, input,
      requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Put('configs/:configId/stripe/credentials')
  @RequirePermissions({
    mode: 'write', permissions: ['commerce.payment.manage'], scope: 'tenant',
  })
  rotateStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.rotateTenant(
      requireTenantId(principal), principal.subjectId, configId, input,
      requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post('configs/:configId/stripe/test')
  @RequirePermissions({
    mode: 'write', permissions: ['commerce.payment.manage'], scope: 'tenant',
  })
  testStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.testTenant(
      requireTenantId(principal), principal.subjectId, configId, input,
      requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post('configs/:configId/stripe/enable')
  @RequirePermissions({
    mode: 'write', permissions: ['commerce.payment.manage'], scope: 'tenant',
  })
  enableStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.setTenantStatus(
      requireTenantId(principal), principal.subjectId, configId, true, input,
      requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Post('configs/:configId/stripe/disable')
  @RequirePermissions({
    mode: 'write', permissions: ['commerce.payment.manage'], scope: 'tenant',
  })
  disableStripe(
    @Param('configId') configId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.stripeConfigurations!.setTenantStatus(
      requireTenantId(principal), principal.subjectId, configId, false, input,
      requireIdempotencyKey(request), uuidV7(),
    );
  }

  @Put('routing')
  @RequirePermissions({
    mode: 'write',
    permissions: ['commerce.payment.manage'],
    scope: 'tenant',
  })
  route(
    @Body() input: { collectionMode?: unknown; paymentConfigId?: unknown },
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    if (typeof input?.paymentConfigId !== 'string') {
      throw new BadRequestException('paymentConfigId is required');
    }
    return this.configurations.setTenantRouting(
      requireTenantId(principal),
      input.paymentConfigId,
      input.collectionMode,
      principal.subjectId,
      uuidV7(),
      requireIdempotencyKey(request),
    );
  }
}

@Controller('customer/commerce')
export class CustomerPaymentController {
  constructor(
    @Inject(PaymentCoreService)
    private readonly payments: PaymentCoreService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('orders/:orderId/payments')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async create(
    @Param('orderId') orderId: string,
    @Body() input: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.payments.createPayment(
      await this.principal(request),
      orderId,
      input,
      headerValue(request.headers['idempotency-key']),
      uuidV7(),
      this.tenantContext.current()?.host,
    );
  }

  @Get('payments/:attemptId')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async detail(
    @Param('attemptId') attemptId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.payments.getPayment(await this.principal(request), attemptId);
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

@Controller('payments/webhooks')
export class PaymentWebhookController {
  constructor(
    @Inject(PaymentCoreService)
    private readonly payments: PaymentCoreService,
  ) {}

  @Post(':configId')
  @PublicEndpoint()
  webhook(
    @Param('configId') configId: string,
    @RawBody() rawBody: Buffer | undefined,
    @Headers('x-payment-signature') signature: string | undefined,
    @Req() request?: FastifyRequest,
  ) {
    const exactSignature = request
      ? singleRawHeader(request, 'x-payment-signature')
      : headerValue(signature, 'x-payment-signature');
    if (!exactSignature) {
      throw new BadRequestException('x-payment-signature is required');
    }
    if (!rawBody || rawBody.byteLength > 64_000) {
      throw new BadRequestException('Webhook raw payload is required and must not exceed 64KB');
    }
    return this.payments.handleWebhook(configId, rawBody, exactSignature, 'fake');
  }

  @Post(':configId/stripe')
  @PublicEndpoint()
  stripeWebhook(
    @Param('configId') configId: string,
    @RawBody() rawBody: Buffer | undefined,
    @Req() request: FastifyRequest,
  ) {
    const signature = singleRawHeader(request, 'stripe-signature');
    if (!signature) throw new BadRequestException('Stripe-Signature is required');
    if (!rawBody || rawBody.byteLength > 64_000) {
      throw new BadRequestException('Webhook raw payload is required and must not exceed 64KB');
    }
    return this.payments.handleWebhook(configId, rawBody, signature, 'stripe');
  }
}

function requireTenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new Error('Tenant principal was not established');
  }
  return principal.tenantId;
}

function headerValue(
  value: string | string[] | undefined,
  headerName = 'Idempotency-Key',
): string | undefined {
  if (Array.isArray(value)) {
    throw new BadRequestException(`${headerName} must be provided exactly once`);
  }
  return value;
}

function singleRawHeader(request: FastifyRequest, headerName: string): string | undefined {
  const rawHeaders = request.raw.rawHeaders;
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === headerName.toLowerCase()) {
      values.push(rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length !== 1 || !values[0]) {
    if (values.length > 1) {
      throw new BadRequestException(`${headerName} must be provided exactly once`);
    }
    return undefined;
  }
  return values[0];
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = headerValue(request.headers['idempotency-key']);
  if (!value) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return value;
}
