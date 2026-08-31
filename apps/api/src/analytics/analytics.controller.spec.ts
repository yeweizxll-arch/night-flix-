import 'reflect-metadata';

import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformAnalyticsController,
  TenantAnalyticsController,
} from './analytics.controller';
import type { AnalyticsService } from './analytics.service';

describe('analytics controller access metadata', () => {
  it.each([
    [PlatformAnalyticsController, 'overview', 'platform', 'platform.analytics.read'],
    [PlatformAnalyticsController, 'tenants', 'platform', 'platform.analytics.read'],
    [TenantAnalyticsController, 'overview', 'tenant', 'tenant.analytics.read'],
  ] as const)(
    '%s.%s requires the scoped analytics read permission',
    (controller, method, scope, permission) => {
      const handler = Reflect.get(controller.prototype, method) as Function;
      expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
        .toEqual({ mode: 'read', permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('fails closed with a 403 when a tenant principal is missing', () => {
    const controller = new TenantAnalyticsController({} as AnalyticsService);
    expect(() => controller.overview({
      permissions: ['tenant.analytics.read'],
      scope: 'platform',
      subjectId: 'platform-staff',
    }, {})).toThrow(ForbiddenException);
  });
});
