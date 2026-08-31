import 'reflect-metadata';

import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { PaymentConfigurationService } from './payment-configuration.service';
import {
  PlatformPaymentConfigurationController,
  TenantPaymentConfigurationController,
} from './payment.controller';

const ACTOR_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d101';
const TENANT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d102';
const CONFIG_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d103';

describe('payment configuration controller policies', () => {
  it('exposes the platform list at the exact protected GET route', () => {
    expect(Reflect.getMetadata(
      PATH_METADATA,
      PlatformPaymentConfigurationController,
    )).toBe('platform/payments/configs');
    expect(Reflect.getMetadata(
      METHOD_METADATA,
      PlatformPaymentConfigurationController.prototype.list,
    )).toBe(RequestMethod.GET);
  });

  it.each([
    [PlatformPaymentConfigurationController, 'list', 'platform', 'read', 'platform.payment.read'],
    [PlatformPaymentConfigurationController, 'createFake', 'platform', 'write', 'platform.payment.manage'],
    [PlatformPaymentConfigurationController, 'createStripe', 'platform', 'write', 'platform.payment.manage'],
    [PlatformPaymentConfigurationController, 'rotateStripe', 'platform', 'write', 'platform.payment.manage'],
    [PlatformPaymentConfigurationController, 'testStripe', 'platform', 'write', 'platform.payment.manage'],
    [PlatformPaymentConfigurationController, 'enableStripe', 'platform', 'write', 'platform.payment.manage'],
    [PlatformPaymentConfigurationController, 'disableStripe', 'platform', 'write', 'platform.payment.manage'],
    [TenantPaymentConfigurationController, 'list', 'tenant', 'read', 'commerce.payment.read'],
    [TenantPaymentConfigurationController, 'createFake', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'createStripe', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'rotateStripe', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'testStripe', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'enableStripe', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'disableStripe', 'tenant', 'write', 'commerce.payment.manage'],
    [TenantPaymentConfigurationController, 'route', 'tenant', 'write', 'commerce.payment.manage'],
  ] as const)(
    '%s.%s is protected by the expected payment permission',
    (controller, method, scope, mode, permission) => {
      const handler = Reflect.get(controller.prototype, method) as Function;
      expect(Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA,
        handler,
      ) as AccessRequirement).toEqual({
        mode,
        permissions: [permission],
        scope,
      });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('uses the authenticated tenant for list and routing', () => {
    const configurations = {
      listTenantPaymentConfigs: vi.fn(),
      setTenantRouting: vi.fn(),
    };
    const controller = new TenantPaymentConfigurationController(
      configurations as unknown as PaymentConfigurationService,
    );
    const principal = tenantPrincipal();

    controller.list(principal);
    controller.route({
      collectionMode: 'platform_collect',
      paymentConfigId: CONFIG_ID,
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e77357d999',
    } as never, principal, request());

    expect(configurations.listTenantPaymentConfigs).toHaveBeenCalledWith(TENANT_ID);
    expect(configurations.setTenantRouting).toHaveBeenCalledWith(
      TENANT_ID,
      CONFIG_ID,
      'platform_collect',
      ACTOR_ID,
      expect.any(String),
      'payment-settings-command-1',
    );
  });

  it('requires one Idempotency-Key before invoking a write service', () => {
    const configurations = { setTenantRouting: vi.fn() };
    const controller = new TenantPaymentConfigurationController(
      configurations as unknown as PaymentConfigurationService,
    );

    expect(() => controller.route(
      { collectionMode: 'platform_collect', paymentConfigId: CONFIG_ID },
      tenantPrincipal(),
      { headers: {} } as FastifyRequest,
    )).toThrow(BadRequestException);
    expect(configurations.setTenantRouting).not.toHaveBeenCalled();
  });

  it('rejects a non-tenant principal before calling the tenant service', () => {
    const configurations = { listTenantPaymentConfigs: vi.fn() };
    const controller = new TenantPaymentConfigurationController(
      configurations as unknown as PaymentConfigurationService,
    );
    const principal: AccessPrincipal = {
      permissions: ['platform.payment.read'],
      scope: 'platform',
      subjectId: ACTOR_ID,
    };

    expect(() => controller.list(principal)).toThrow(
      'Tenant principal was not established',
    );
    expect(configurations.listTenantPaymentConfigs).not.toHaveBeenCalled();
  });
});

function tenantPrincipal(): AccessPrincipal {
  return {
    permissions: ['commerce.payment.read', 'commerce.payment.manage'],
    scope: 'tenant',
    subjectId: ACTOR_ID,
    tenantId: TENANT_ID,
    tenantState: 'active',
  };
}

function request(): FastifyRequest {
  return {
    headers: { 'idempotency-key': 'payment-settings-command-1' },
  } as unknown as FastifyRequest;
}
