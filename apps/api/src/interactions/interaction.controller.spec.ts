import 'reflect-metadata';

import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import {
  CustomerInteractionController,
  PlatformInteractionController,
  TenantInteractionController,
} from './interaction.controller';
import type { InteractionService } from './interaction.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('CustomerInteractionController', () => {
  it('marks every manually authenticated customer route public', () => {
    for (const method of [
      'listComments',
      'createComment',
      'deleteComment',
      'listBulletComments',
      'createBulletComment',
      'deleteBulletComment',
      'report',
    ] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        CustomerInteractionController.prototype[method],
      )).toBe(true);
    }
  });

  it('requires a verified bearer token even though the route is Public', async () => {
    const listComments = vi.fn(async () => ({ items: [] }));
    const authenticateAccess = vi.fn(async () => ({ accountId, tenantId }));
    const controller = customerController({ listComments }, { authenticateAccess });
    await expect(controller.listComments({}, request())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authenticateAccess).not.toHaveBeenCalled();
    await controller.listComments(
      { dramaId: '33333333-3333-4333-8333-333333333333' },
      request({ authorization: `Bearer ${accessToken}` }),
    );
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
  });

  it('rejects duplicate idempotency headers before authentication and writes', async () => {
    const createComment = vi.fn();
    const authenticateAccess = vi.fn();
    const controller = customerController({ createComment }, { authenticateAccess });
    await expect(controller.createComment(
      {},
      request({ 'idempotency-key': ['key-one-123', 'key-two-123'] }),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe('staff interaction controllers', () => {
  it.each([
    [TenantInteractionController, 'listModeration', 'read', 'tenant.interaction.read', 'tenant'],
    [TenantInteractionController, 'moderate', 'write', 'tenant.interaction.manage', 'tenant'],
    [TenantInteractionController, 'listSensitiveWords', 'read', 'tenant.interaction.read', 'tenant'],
    [TenantInteractionController, 'createSensitiveWord', 'write', 'tenant.sensitive_word.manage', 'tenant'],
    [TenantInteractionController, 'disableSensitiveWord', 'write', 'tenant.sensitive_word.manage', 'tenant'],
    [PlatformInteractionController, 'listModeration', 'read', 'platform.interaction.read', 'platform'],
    [PlatformInteractionController, 'moderate', 'write', 'platform.interaction.manage', 'platform'],
    [PlatformInteractionController, 'listSensitiveWords', 'read', 'platform.interaction.read', 'platform'],
    [PlatformInteractionController, 'createSensitiveWord', 'write', 'platform.sensitive_word.manage', 'platform'],
    [PlatformInteractionController, 'disableSensitiveWord', 'write', 'platform.sensitive_word.manage', 'platform'],
  ] as const)(
    '%s.%s has an explicit scoped permission',
    (controller, method, mode, permission, scope) => {
      const handler = Reflect.get(controller.prototype, method) as Function;
      expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
        .toEqual({ mode, permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );
});

function customerController(
  interactions: Record<string, unknown>,
  authentication: Record<string, unknown>,
): CustomerInteractionController {
  return new CustomerInteractionController(
    interactions as unknown as InteractionService,
    authentication as unknown as CustomerAuthenticationService,
    {
      current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
    } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
