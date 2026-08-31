import { describe, expect, it } from 'vitest';

import type { AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformPublicDramaPoolController,
  TenantAppRuntimeConfigController,
  TenantPublicDramaPoolController,
} from './public-drama-pool.controller';
import { PlatformContentRevenueController } from './revenue-share.controller';

describe('public drama pool controller policies', () => {
  it.each([
    [TenantPublicDramaPoolController, 'list', 'tenant', 'read', 'content.drama.read'],
    [TenantPublicDramaPoolController, 'review', 'tenant', 'write', 'content.drama.submit_review'],
    [TenantPublicDramaPoolController, 'publish', 'tenant', 'write', 'content.drama.update'],
    [TenantPublicDramaPoolController, 'unpublish', 'tenant', 'write', 'content.drama.update'],
    [TenantAppRuntimeConfigController, 'get', 'tenant', 'read', 'tenant.site.read'],
    [TenantAppRuntimeConfigController, 'update', 'tenant', 'write', 'tenant.site.manage'],
    [PlatformPublicDramaPoolController, 'emergencyTakedown', 'platform', 'write', 'platform.content.publish'],
    [PlatformContentRevenueController, 'policy', 'platform', 'write', 'finance.settlement.manage'],
    [PlatformContentRevenueController, 'ledger', 'platform', 'read', 'finance.withdrawal.read'],
  ] as const)('%s.%s enforces scope and permission',
    (controller, method, scope, mode, permission) => {
      const handler = Reflect.get(controller.prototype, method) as (...args: never[]) => unknown;
      const requirement = Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA, handler,
      ) as AccessRequirement;
      expect(requirement).toEqual({ mode, permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    });
});
