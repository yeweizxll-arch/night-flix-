import { describe, expect, it } from 'vitest';

import {
  canEnableCommunication,
  communicationTestErrorLabel,
  testHasSettled,
} from './communication-ui';

const passed = {
  channel: 'email' as const,
  lastTestStatus: 'passed' as const,
  lastTestedAt: '2026-08-22T00:00:00.000Z',
  status: 'disabled' as const,
  version: 3,
};

describe('communication configuration UI state', () => {
  it('only enables a disabled, passed configuration with no test pending', () => {
    expect(canEnableCommunication(passed, undefined)).toBe(true);
    expect(canEnableCommunication({ ...passed, status: 'active' }, undefined)).toBe(false);
    expect(canEnableCommunication(passed, { previousTestedAt: passed.lastTestedAt, version: 3 }))
      .toBe(false);
  });

  it('settles pending state only for a new result or changed config version', () => {
    const pending = { previousTestedAt: passed.lastTestedAt, version: 3 };
    expect(testHasSettled(passed, pending)).toBe(false);
    expect(testHasSettled({ ...passed, lastTestedAt: '2026-08-22T00:01:00.000Z' }, pending))
      .toBe(true);
    expect(testHasSettled({ ...passed, version: 4 }, pending)).toBe(true);
    const newlyRequested = { version: 4 };
    expect(testHasSettled({
      ...passed, lastTestStatus: undefined, lastTestedAt: undefined, version: 4,
    }, newlyRequested)).toBe(false);
    expect(testHasSettled({
      ...passed, lastTestedAt: '2026-08-22T00:02:00.000Z', version: 4,
    }, newlyRequested)).toBe(true);
  });

  it('maps provider failures to controlled messages and hides unknown details', () => {
    expect(communicationTestErrorLabel('provider_timeout')).toBe('渠道响应超时，请稍后重试');
    expect(communicationTestErrorLabel('raw-provider-secret-error'))
      .toBe('测试失败，请检查渠道配置后重试');
  });
});
