export interface RuntimeConfig {
  admob: Record<string, unknown>;
  allowedCountries: string[];
  deepLinkHost?: string;
  featureFlags: Record<string, unknown>;
  storeProducts: Record<string, unknown>;
  supportedLocales: string[];
  version: number;
}

export const adFormats = [
  { value: 'appOpen', label: '开屏广告' },
  { value: 'native', label: '原生信息流广告' },
  { value: 'interstitial', label: '插屏广告' },
  { value: 'rewardedEpisode', label: '看广告解锁一集' },
] as const;
export interface RuntimeValues {
  adsEnabled: boolean;
  ads: { android: Record<string, string>; ios: Record<string, string> };
  allowedCountries: string[];
  deepLinkHost?: string;
  products: { platform: 'apple' | 'google'; id: string; kind: 'points_topup' | 'membership' }[];
  supportedLocales: string[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function runtimeToForm(config: RuntimeConfig): RuntimeValues {
  const ads: RuntimeValues['ads'] = { android: {}, ios: {} };
  for (const platform of ['android', 'ios'] as const) {
    for (const { value: format } of adFormats) {
      const nested = config.admob[platform];
      const value = nested && typeof nested === 'object'
        ? object(nested)[format]
        : config.admob[`${format}${platform === 'ios' ? 'Ios' : 'Android'}`]
          ?? (format === 'rewardedEpisode' ? config.admob.rewardedEpisode ?? config.admob.rewarded : undefined);
      ads[platform][format] = typeof value === 'string' ? value : '';
    }
  }
  return {
    adsEnabled: Object.keys(config.admob).length > 0 && config.admob.enabled !== false,
    ads, allowedCountries: config.allowedCountries, deepLinkHost: config.deepLinkHost,
    products: (['apple', 'google'] as const).flatMap(platform => {
      const entries = config.storeProducts[platform];
      return Array.isArray(entries) ? entries.filter(item => item && typeof item.id === 'string'
        && ['points_topup', 'membership'].includes(item.kind)).map(item => ({ platform, id: item.id, kind: item.kind })) : [];
    }),
    supportedLocales: config.supportedLocales,
  };
}

export function runtimePayload(values: RuntimeValues, previous: RuntimeConfig) {
  const admob: Record<string, unknown> = { ...previous.admob, enabled: values.adsEnabled };
  for (const platform of ['android', 'ios'] as const) {
    const entries = { ...object(previous.admob[platform]) };
    for (const { value: format } of adFormats) {
      const unit = values.ads[platform]?.[format]?.trim();
      if (unit && !/^ca-app-pub-\d{16}\/\d{10}$/.test(unit)) throw new Error('广告位 ID 格式不正确');
      if (unit) entries[format] = unit;
      else delete entries[format];
    }
    // An explicit platform object prevents cleared IDs falling back to legacy values.
    admob[platform] = entries;
  }
  const storeProducts = { ...previous.storeProducts };
  for (const platform of ['apple', 'google'] as const) {
    const seen = new Set<string>();
    storeProducts[platform] = (values.products ?? []).filter(item => item.platform === platform).map(item => {
      const id = item.id?.trim();
      if (!id || !['points_topup', 'membership'].includes(item.kind)) throw new Error('请完整填写商店商品');
      if (seen.has(id)) throw new Error('同一商店不能重复配置商品 ID');
      seen.add(id);
      const old = previous.storeProducts[platform];
      const existing = Array.isArray(old) ? old.find(entry => entry?.id === id) : undefined;
      return { ...object(existing), id, kind: item.kind };
    });
  }
  return {
    admob, storeProducts, featureFlags: previous.featureFlags,
    supportedLocales: values.supportedLocales,
    allowedCountries: [...new Set((values.allowedCountries ?? []).map(code => code.trim().toUpperCase()))],
    deepLinkHost: values.deepLinkHost?.trim() || null, expectedVersion: previous.version,
  };
}
