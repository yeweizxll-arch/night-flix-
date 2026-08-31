import { describe, expect, it } from 'vitest';

import {
  canEnableNotificationProvider,
  providerConfigPayload,
  providerEnvironmentLabel,
  safeNotificationTestError,
} from './notification-ui';

describe('notification UI security policy', () => {
  it('only enables a disabled provider after an actual passed test', () => {
    expect(canEnableNotificationProvider(undefined)).toBe(false);
    expect(canEnableNotificationProvider({ status: 'disabled' })).toBe(false);
    expect(canEnableNotificationProvider({ lastTestStatus: 'failed', status: 'disabled' })).toBe(false);
    expect(canEnableNotificationProvider({ lastTestStatus: 'passed', status: 'active' })).toBe(false);
    expect(canEnableNotificationProvider({ lastTestStatus: 'passed', status: 'disabled' })).toBe(true);
  });

  it('does not expose an unknown provider error value', () => {
    const secretLookingError = 'upstream said token=very-secret-value';
    expect(safeNotificationTestError(secretLookingError)).not.toContain(secretLookingError);
    expect(safeNotificationTestError(secretLookingError)).not.toContain('very-secret-value');
  });

  it('submits APNs environment separately with the credential replacement contract', () => {
    expect(providerConfigPayload('apns', {
      bundleId: ' com.example.drama ',
      environment: 'sandbox',
      keyId: ' KEY123 ',
      privateKey: 'secret-private-key',
      teamId: ' TEAM123 ',
    }, 7)).toEqual({
      credentials: {
        bundleId: 'com.example.drama',
        keyId: 'KEY123',
        privateKey: 'secret-private-key',
        teamId: 'TEAM123',
      },
      environment: 'sandbox',
      expectedVersion: 7,
    });
    expect(() => providerConfigPayload('apns', {
      privateKey: 'secret-private-key',
    }, 0)).toThrow(/environment/);
  });

  it('keeps FCM fixed to production and uses safe environment labels', () => {
    expect(providerConfigPayload('fcm', {
      clientEmail: ' push@example.com ',
      environment: 'sandbox',
      privateKey: 'secret-private-key',
      projectId: ' project-id ',
    }, 2)).toEqual({
      credentials: {
        clientEmail: 'push@example.com',
        privateKey: 'secret-private-key',
        projectId: 'project-id',
      },
      environment: 'production',
      expectedVersion: 2,
    });
    expect(providerEnvironmentLabel('apns', 'sandbox')).toContain('测试安装包');
    expect(providerEnvironmentLabel('apns', 'production')).toContain('上架包');
    expect(providerEnvironmentLabel('fcm', 'production')).toContain('固定');
  });
});
