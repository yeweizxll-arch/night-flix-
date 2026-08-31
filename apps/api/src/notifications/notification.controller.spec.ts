import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import type { CustomerNotificationService } from './customer-notification.service';
import {
  CustomerNotificationController,
  TenantNotificationController,
} from './notification.controller';
import type { TenantNotificationService } from './tenant-notification.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('CustomerNotificationController', () => {
  it('marks every manually bearer-authenticated customer route public', () => {
    for (const method of [
      'preferences', 'updatePreferences', 'inbox', 'markRead',
      'registerPushToken', 'unregisterPushToken',
    ] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerNotificationController.prototype[method],
      )).toBe(true);
    }
  });

  it('still requires a bearer token and verified tenant domain', async () => {
    const getPreferences = vi.fn();
    const authenticateAccess = vi.fn(async () => ({ accountId, tenantId }));
    const controller = new CustomerNotificationController(
      { getPreferences } as unknown as CustomerNotificationService,
      { authenticateAccess } as unknown as CustomerAuthenticationService,
      { current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })) } as unknown as TenantContextService,
    );
    await expect(controller.preferences(request())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(getPreferences).not.toHaveBeenCalled();
    await controller.preferences(request({ authorization: `Bearer ${accessToken}` }));
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
  });
});

describe('TenantNotificationController', () => {
  it.each([
    ['listConfigs', 'read', 'tenant.notification.read'],
    ['listCampaigns', 'read', 'tenant.notification.read'],
    ['getCampaign', 'read', 'tenant.notification.read'],
    ['upsertConfig', 'write', 'tenant.notification.config.manage'],
    ['testConfig', 'write', 'tenant.notification.config.manage'],
    ['enableConfig', 'write', 'tenant.notification.config.manage'],
    ['disableConfig', 'write', 'tenant.notification.config.manage'],
    ['createCampaign', 'write', 'tenant.notification.campaign.manage'],
    ['updateCampaign', 'write', 'tenant.notification.campaign.manage'],
    ['scheduleCampaign', 'write', 'tenant.notification.campaign.manage'],
    ['cancelCampaign', 'write', 'tenant.notification.campaign.manage'],
  ] as const)('%s has a scoped permission', (method, mode, permission) => {
    const requirement = Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      TenantNotificationController.prototype[method],
    ) as AccessRequirement;
    expect(requirement).toEqual({ mode, permissions: [permission], scope: 'tenant' });
  });

  it('rejects duplicate idempotency headers before a campaign write', async () => {
    const createCampaign = vi.fn();
    const controller = new TenantNotificationController({
      createCampaign,
    } as unknown as TenantNotificationService);
    expect(() => controller.createCampaign(
      {},
      ({
        permissions: [],
        roles: [],
        scope: 'tenant',
        subjectId: accountId,
        tenantId,
      } as AccessPrincipal),
      request({ 'idempotency-key': ['first-key', 'second-key'] }),
    )).toThrow(BadRequestException);
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it('passes optimistic versions through schedule and cancel commands', async () => {
    const scheduleCampaign = vi.fn();
    const cancelCampaign = vi.fn();
    const controller = new TenantNotificationController({
      cancelCampaign,
      scheduleCampaign,
    } as unknown as TenantNotificationService);
    const principal = {
      permissions: [], roles: [], scope: 'tenant', subjectId: accountId, tenantId,
    } as AccessPrincipal;
    const mutationRequest = request({ 'idempotency-key': 'campaign-version-command' });

    controller.scheduleCampaign(
      '33333333-3333-4333-8333-333333333333',
      { expectedVersion: 4, scheduledAt: '2099-01-01T00:00:00.000Z' },
      principal,
      mutationRequest,
    );
    expect(scheduleCampaign).toHaveBeenCalledWith(
      tenantId,
      '33333333-3333-4333-8333-333333333333',
      { expectedVersion: 4, scheduledAt: '2099-01-01T00:00:00.000Z' },
      expect.objectContaining({ idempotencyKey: 'campaign-version-command' }),
    );

    controller.cancelCampaign(
      '33333333-3333-4333-8333-333333333333',
      { expectedVersion: 5, reason: 'operator stop' },
      principal,
      mutationRequest,
    );
    expect(cancelCampaign).toHaveBeenCalledWith(
      tenantId,
      '33333333-3333-4333-8333-333333333333',
      { expectedVersion: 5, reason: 'operator stop' },
      expect.objectContaining({ idempotencyKey: 'campaign-version-command' }),
    );
  });
});

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
