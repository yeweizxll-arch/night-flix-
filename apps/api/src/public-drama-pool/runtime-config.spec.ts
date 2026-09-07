import { describe, expect, it } from 'vitest';
import { runtimeConfigInput } from './public-drama-pool.service';
import type { TenantAppRuntimeConfigInput } from './public-drama-pool.types';

describe('runtime configuration input', () => {
  it.each(['en-US', 1, {}, [], [null], ['bad_locale']])('rejects malformed locales without a server error: %j', value => {
    expect(() => runtimeConfigInput({ expectedVersion: 0, supportedLocales: value } as unknown as TenantAppRuntimeConfigInput)).toThrow('请选择有效的支持语言');
  });
  it.each([{ apple: {} }, { google: 'product' }, { apple: [null] }, { google: [{ id: 'coins', kind: 'typo' }] },
    { google: [{ id: 'coins', kind: 'points_topup' }, { id: 'coins', kind: 'membership' }] }])('rejects crash-prone store mappings: %j', storeProducts => {
    expect(() => runtimeConfigInput({ expectedVersion: 0, storeProducts })).toThrow();
  });
  it.each([{ enabled: 'false' }, { android: [] }, { ios: { native: 'invalid' } }])('rejects invalid ads: %j', admob => {
    expect(() => runtimeConfigInput({ expectedVersion: 0, admob })).toThrow();
  });
  it('accepts the native-client shapes and deduplicates locales', () => {
    const input = { expectedVersion: 2, supportedLocales: ['zh-CN', 'en-US', 'zh-CN'],
      admob: { enabled: true, android: { rewardedEpisode: 'ca-app-pub-1234567890123456/1234567890' } },
      storeProducts: { google: [{ id: 'coins100', kind: 'points_topup' }] } };
    expect(runtimeConfigInput(input)).toMatchObject({ ...input, supportedLocales: ['zh-CN', 'en-US'] });
  });
});
