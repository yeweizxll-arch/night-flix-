export const CUSTOMER_CONTENT_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
] as const;

export type CustomerContentLocale = (typeof CUSTOMER_CONTENT_LOCALES)[number];

export interface CustomerDramaCatalogItem {
  code: string;
  coverMediaId?: string;
  id: string;
  locale: CustomerContentLocale;
  pointsAmount?: number;
  summary: string;
  title: string;
  totalEpisodes: number;
}

export interface CustomerEpisodeCatalogItem {
  durationSeconds: number;
  episodeNo: number;
  id: string;
  locale: CustomerContentLocale;
  mediaAssetId: string;
  pointsAmount?: number;
  previewSeconds: number;
  title: string;
  tracks: CustomerEpisodeMediaTrack[];
}

export interface CustomerEpisodeMediaTrack {
  id: string;
  isDefault: boolean;
  label: string;
  locale: string;
  mediaAssetId: string;
  type: 'dubbing' | 'subtitle';
}

export interface CustomerDramaCatalogDetail extends CustomerDramaCatalogItem {
  episodes: CustomerEpisodeCatalogItem[];
}

export interface CustomerDramaCatalogQuery {
  category?: unknown;
  locale?: unknown;
  page?: unknown;
  pageSize?: unknown;
  q?: unknown;
  tag?: unknown;
}
