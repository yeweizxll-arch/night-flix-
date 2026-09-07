import { describe, expect, it } from 'vitest';
import { runtimePayload, runtimeToForm, type RuntimeConfig } from './runtime-config-ui';

const base: RuntimeConfig = { admob: {}, allowedCountries: [], featureFlags: { preserve: true }, storeProducts: {}, supportedLocales: ['zh-CN'], version: 3 };
const unit = 'ca-app-pub-1234567890123456/1234567890';
describe('operator runtime configuration', () => {
  it('keeps opaque configuration and version while editing supported fields', () => {
    const old = { ...base, storeProducts: { custom: 'preserved', google: [{ id: 'coins', kind: 'points_topup', amount: 100 }] } };
    const form = runtimeToForm(old);
    expect(runtimePayload(form, old)).toMatchObject({ featureFlags: base.featureFlags, expectedVersion: 3,
      storeProducts: old.storeProducts });
  });
  it('migrates legacy ad IDs and clearing does not resurrect the fallback', () => {
    const old = { ...base, admob: { rewarded: unit } };
    const form = runtimeToForm(old);
    expect(form.ads.android.rewardedEpisode).toBe(unit);
    form.ads.android.rewardedEpisode = '';
    const saved = runtimePayload(form, old);
    expect(runtimeToForm({ ...old, ...saved, deepLinkHost: undefined }).ads.android.rewardedEpisode).toBe('');
    expect((saved.admob.ios as Record<string, unknown>).rewardedEpisode).toBe(unit);
  });
  it('rejects duplicate store IDs in one platform but permits the same ID across stores', () => {
    const form = runtimeToForm(base);
    form.products = [{ platform: 'google', id: 'coins', kind: 'points_topup' }, { platform: 'google', id: 'coins', kind: 'membership' }];
    expect(() => runtimePayload(form, base)).toThrow('重复');
    form.products[1]!.platform = 'apple';
    expect(() => runtimePayload(form, base)).not.toThrow();
  });
  it('rejects malformed ad IDs and normalizes country codes', () => {
    const form = runtimeToForm(base);
    form.ads.android.native = 'bad';
    expect(() => runtimePayload(form, base)).toThrow('广告位');
    form.ads.android.native = unit; form.allowedCountries = ['us', 'US'];
    expect(runtimePayload(form, base).allowedCountries).toEqual(['US']);
  });
});
