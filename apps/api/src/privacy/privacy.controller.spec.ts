import 'reflect-metadata';

import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CustomerPrivacyController,
  TenantPrivacyRequestController,
} from './customer-privacy.controller';
import type { CustomerPrivacyService } from './customer-privacy.service';
import {
  CustomerLegalDocumentController,
  TenantLegalDocumentController,
} from './legal-document.controller';
import type { LegalDocumentService } from './legal-document.service';

const TENANT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357ef01';
const ACCOUNT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357ef02';
const STAFF_ID = '018f2f45-7f5e-7e70-b17f-f6e77357ef03';
const REQUEST_ID = '018f2f45-7f5e-7e70-b17f-f6e77357ef04';
const ACCESS_TOKEN = `atk_${'a'.repeat(43)}`;

describe('privacy and legal controller policies', () => {
  it('marks only self-authenticated customer routes public at the global guards', () => {
    for (const [controller, methods] of [
      [CustomerLegalDocumentController, ['current', 'detail']],
      [CustomerPrivacyController, ['consents', 'exportData', 'requestErasure']],
    ] as const) {
      for (const method of methods) {
        const handler = Reflect.get(controller.prototype, method) as Function;
        expect(Reflect.getMetadata(
          PUBLIC_ENDPOINT_METADATA,
          handler,
        )).toBe(true);
      }
    }
  });

  it.each([
    [TenantLegalDocumentController, 'list', 'read', 'tenant.legal.read'],
    [TenantLegalDocumentController, 'create', 'write', 'tenant.legal.manage'],
    [TenantLegalDocumentController, 'update', 'write', 'tenant.legal.manage'],
    [TenantLegalDocumentController, 'publish', 'write', 'tenant.legal.manage'],
    [TenantLegalDocumentController, 'removeDraft', 'write', 'tenant.legal.manage'],
    [TenantPrivacyRequestController, 'list', 'read', 'tenant.privacy_request.read'],
    [TenantPrivacyRequestController, 'detail', 'read', 'tenant.privacy_request.read'],
  ] as const)('%s.%s has the exact tenant permission', (controller, method, mode, permission) => {
    const handler = Reflect.get(controller.prototype, method) as Function;
    expect(Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      handler,
    ) as AccessRequirement).toEqual({ mode, permissions: [permission], scope: 'tenant' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('requires an explicit bearer token on customer privacy routes', async () => {
    const authenticateAccessForAccountClosure = vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      deviceId: REQUEST_ID,
      sessionId: REQUEST_ID,
      tenantId: TENANT_ID,
      username: 'privacy-user',
    }));
    const listConsents = vi.fn(async () => ({ items: [] }));
    const controller = new CustomerPrivacyController(
      { listConsents } as unknown as CustomerPrivacyService,
      { authenticateAccessForAccountClosure } as unknown as CustomerAuthenticationService,
      context() as unknown as TenantContextService,
    );

    await expect(controller.consents(request())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.consents(request({ authorization: `Bearer ${ACCESS_TOKEN}` })))
      .resolves.toEqual({ items: [] });
    expect(authenticateAccessForAccountClosure).toHaveBeenCalledWith(TENANT_ID, ACCESS_TOKEN);
    expect(listConsents).toHaveBeenCalledWith(expect.objectContaining({
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
    }));
  });

  it('rejects unavailable hosts and duplicate erasure idempotency headers before service work', async () => {
    const requestErasure = vi.fn();
    const authentication = { authenticateAccessForAccountClosure: vi.fn() };
    const unknown = new CustomerPrivacyController(
      { requestErasure } as unknown as CustomerPrivacyService,
      authentication as unknown as CustomerAuthenticationService,
      context(null) as unknown as TenantContextService,
    );
    await expect(unknown.requestErasure({}, request({ authorization: `Bearer ${ACCESS_TOKEN}` })))
      .rejects.toBeInstanceOf(BadRequestException);

    const duplicate = new CustomerPrivacyController(
      { requestErasure } as unknown as CustomerPrivacyService,
      { authenticateAccessForAccountClosure: vi.fn(async () => ({
        accountId: ACCOUNT_ID, tenantId: TENANT_ID,
      })) } as unknown as CustomerAuthenticationService,
      context() as unknown as TenantContextService,
    );
    await expect(duplicate.requestErasure({}, request({
      authorization: `Bearer ${ACCESS_TOKEN}`,
      'idempotency-key': ['one-command', 'two-command'],
    }))).rejects.toBeInstanceOf(BadRequestException);
    expect(requestErasure).not.toHaveBeenCalled();
  });

  it('derives tenant administration scope only from the verified context and principal', () => {
    const list = vi.fn();
    const controller = new TenantPrivacyRequestController(
      { listTenantRequests: list } as unknown as CustomerPrivacyService,
      context() as unknown as TenantContextService,
    );
    const principal: AccessPrincipal = {
      permissions: ['tenant.privacy_request.read'],
      scope: 'tenant',
      subjectId: STAFF_ID,
      tenantId: TENANT_ID,
      tenantState: 'active',
    };
    controller.list({ tenantId: '018f2f45-7f5e-7e70-b17f-f6e77357efff' }, principal);
    expect(list).toHaveBeenCalledWith(TENANT_ID, expect.any(Object));

    expect(() => controller.list({}, {
      permissions: ['platform.audit.read'],
      scope: 'platform',
      subjectId: STAFF_ID,
    })).toThrow(ForbiddenException);
  });
});

function context(value: unknown = {
  tenantId: TENANT_ID,
  tenantStatus: 'active',
}) {
  return { current: vi.fn(() => value) };
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.20' } as FastifyRequest;
}
