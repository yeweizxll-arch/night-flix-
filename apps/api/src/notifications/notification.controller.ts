import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentPrincipal, type AccessPrincipal, RequirePermissions } from '../access-control';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { CustomerNotificationService } from './customer-notification.service';
import { TenantNotificationService } from './tenant-notification.service';
import type {
  CancelCampaignInput,
  CreateCampaignInput,
  NotificationMutationMetadata,
  RegisterPushTokenInput,
  ScheduleCampaignInput,
  UpdateNotificationPreferencesInput,
  UpsertProviderConfigInput,
  UpdateCampaignInput,
} from './notification.types';

@Controller('customer/notifications')
export class CustomerNotificationController {
  constructor(
    @Inject(CustomerNotificationService) private readonly notifications: CustomerNotificationService,
    @Inject(CustomerAuthenticationService) private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService) private readonly tenantContext: TenantContextService,
  ) {}

  @Get('preferences')
  @PublicEndpoint()
  async preferences(@Req() request: FastifyRequest) {
    return this.notifications.getPreferences(await this.principal(request));
  }

  @Put('preferences')
  @PublicEndpoint()
  async updatePreferences(
    @Body() input: UpdateNotificationPreferencesInput,
    @Req() request: FastifyRequest,
  ) {
    const principal = await this.principal(request);
    return this.notifications.updatePreferences(principal, input, customerMetadata(principal, request));
  }

  @Get('inbox')
  @PublicEndpoint()
  async inbox(@Query() query: Record<string, unknown>, @Req() request: FastifyRequest) {
    return this.notifications.listInbox(await this.principal(request), query.page, query.pageSize);
  }

  @Post('inbox/:messageId/read')
  @PublicEndpoint()
  async markRead(@Param('messageId') messageId: string, @Req() request: FastifyRequest) {
    return this.notifications.markInboxRead(await this.principal(request), messageId);
  }

  @Post('push-tokens')
  @PublicEndpoint()
  async registerPushToken(@Body() input: RegisterPushTokenInput, @Req() request: FastifyRequest) {
    const principal = await this.principal(request);
    return this.notifications.registerPushToken(principal, input, customerMetadata(principal, request));
  }

  @Delete('push-tokens/:tokenId')
  @PublicEndpoint()
  async unregisterPushToken(@Param('tokenId') tokenId: string, @Req() request: FastifyRequest) {
    const principal = await this.principal(request);
    return this.notifications.unregisterPushToken(principal, tokenId, customerMetadata(principal, request));
  }

  private async principal(request: FastifyRequest): Promise<CustomerPrincipal> {
    const context = this.tenantContext.current();
    if (!context?.tenantId) throw new BadRequestException('A verified tenant domain is required');
    if (context.tenantStatus !== 'active') throw new ForbiddenException('Tenant is unavailable');
    return this.authentication.authenticateAccess(context.tenantId, bearerToken(request));
  }
}

@Controller('tenant/notifications')
export class TenantNotificationController {
  constructor(@Inject(TenantNotificationService) private readonly notifications: TenantNotificationService) {}

  @Get('provider-configs')
  @RequirePermissions({ mode: 'read', permissions: ['tenant.notification.read'], scope: 'tenant' })
  listConfigs(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.notifications.listProviderConfigs(tenantId(principal));
  }

  @Put('provider-configs/:provider')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.config.manage'], scope: 'tenant' })
  upsertConfig(
    @Param('provider') provider: string,
    @Body() input: UpsertProviderConfigInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.upsertProviderConfig(
      tenantId(principal), provider, input, staffMetadata(principal, request),
    );
  }

  @Post('provider-configs/:provider/test')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.config.manage'], scope: 'tenant' })
  testConfig(
    @Param('provider') provider: string,
    @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.testProviderConfig(
      tenantId(principal), provider, input.expectedVersion, staffMetadata(principal, request),
    );
  }

  @Post('provider-configs/:provider/enable')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.config.manage'], scope: 'tenant' })
  enableConfig(
    @Param('provider') provider: string,
    @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.setProviderStatus(
      tenantId(principal), provider, true, input.expectedVersion, staffMetadata(principal, request),
    );
  }

  @Post('provider-configs/:provider/disable')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.config.manage'], scope: 'tenant' })
  disableConfig(
    @Param('provider') provider: string,
    @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.setProviderStatus(
      tenantId(principal), provider, false, input.expectedVersion, staffMetadata(principal, request),
    );
  }

  @Post('campaigns')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.campaign.manage'], scope: 'tenant' })
  createCampaign(
    @Body() input: CreateCampaignInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.createCampaign(
      tenantId(principal), input, staffMetadata(principal, request),
    );
  }

  @Get('campaigns')
  @RequirePermissions({ mode: 'read', permissions: ['tenant.notification.read'], scope: 'tenant' })
  listCampaigns(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.notifications.listCampaigns(tenantId(principal), query);
  }

  @Get('campaigns/:campaignId')
  @RequirePermissions({ mode: 'read', permissions: ['tenant.notification.read'], scope: 'tenant' })
  getCampaign(
    @Param('campaignId') campaignId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.notifications.getCampaign(tenantId(principal), campaignId);
  }

  @Put('campaigns/:campaignId')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.campaign.manage'], scope: 'tenant' })
  updateCampaign(
    @Param('campaignId') campaignId: string,
    @Body() input: UpdateCampaignInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.updateDraftCampaign(
      tenantId(principal), campaignId, input, staffMetadata(principal, request),
    );
  }

  @Post('campaigns/:campaignId/schedule')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.campaign.manage'], scope: 'tenant' })
  scheduleCampaign(
    @Param('campaignId') campaignId: string,
    @Body() input: ScheduleCampaignInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.scheduleCampaign(
      tenantId(principal), campaignId, input, staffMetadata(principal, request),
    );
  }

  @Post('campaigns/:campaignId/cancel')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.notification.campaign.manage'], scope: 'tenant' })
  cancelCampaign(
    @Param('campaignId') campaignId: string,
    @Body() input: CancelCampaignInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.notifications.cancelCampaign(
      tenantId(principal), campaignId, input, staffMetadata(principal, request),
    );
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new ForbiddenException('Tenant principal is required');
  }
  return principal.tenantId;
}

function staffMetadata(principal: AccessPrincipal, request: FastifyRequest): NotificationMutationMetadata {
  return {
    actorId: principal.subjectId,
    actorType: 'tenant_staff',
    idempotencyKey: oneIdempotencyKey(request),
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function customerMetadata(
  principal: CustomerPrincipal,
  request: FastifyRequest,
): NotificationMutationMetadata {
  return {
    actorId: principal.accountId,
    actorType: 'user',
    ip: request.ip,
    requestId: uuidV7(),
  };
}

function oneIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new BadRequestException('Idempotency-Key header is ambiguous');
    return value[0] ?? '';
  }
  if (typeof value !== 'string') throw new BadRequestException('Idempotency-Key header is required');
  return value;
}
