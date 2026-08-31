export const CONTENT_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
] as const;

export type ContentLocale = (typeof CONTENT_LOCALES)[number];

export interface PlatformContentMutationMetadata {
  actorId: string;
  idempotencyKey: string;
  ip?: string;
  requestId: string;
}

export interface DramaTranslationInput {
  locale: ContentLocale;
  searchKeywords?: string[];
  summary?: string;
  title: string;
}

export interface EpisodeTranslationInput {
  locale: ContentLocale;
  title: string;
}

export interface CreatePlatformDramaInput {
  categoryId?: string;
  code: string;
  coverMediaAssetId?: string;
  releaseAt?: string;
  tagIds?: string[];
  translations: DramaTranslationInput[];
  unpublishAt?: string;
}

export interface UpdatePlatformDramaInput {
  categoryId?: string | null;
  code?: string;
  coverMediaAssetId?: string | null;
  expectedVersion: number;
  releaseAt?: string | null;
  tagIds?: string[];
  translations?: DramaTranslationInput[];
  unpublishAt?: string | null;
}

export interface CreatePlatformEpisodeInput {
  durationSeconds: number;
  episodeNo: number;
  expectedDramaVersion: number;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds?: number;
  releaseAt?: string;
  translations: EpisodeTranslationInput[];
  unpublishAt?: string;
}

export interface UpdatePlatformEpisodeInput {
  durationSeconds?: number;
  episodeNo?: number;
  expectedVersion: number;
  mediaAssetId?: string;
  previewMediaAssetId?: string | null;
  previewSeconds?: number;
  releaseAt?: string | null;
  translations?: EpisodeTranslationInput[];
  unpublishAt?: string | null;
}

export interface ExpectedVersionInput {
  expectedVersion: number;
}

export interface DeletePlatformContentInput extends ExpectedVersionInput {
  reason: string;
}

export interface TaxonomyTranslationInput {
  locale: ContentLocale;
  name: string;
}

export interface CreatePlatformTaxonomyInput {
  code: string;
  sortOrder?: number;
  status?: 'active' | 'disabled';
  translations: TaxonomyTranslationInput[];
}

export interface UpdatePlatformTaxonomyInput {
  code?: string;
  expectedVersion: number;
  sortOrder?: number;
  status?: 'active' | 'disabled';
  translations?: TaxonomyTranslationInput[];
}

export interface PlatformEpisodeRecord {
  dramaId: string;
  durationSeconds: number;
  episodeNo: number;
  id: string;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
  releaseAt?: string;
  status: 'approved' | 'draft' | 'published' | 'unpublished';
  translations: EpisodeTranslationInput[];
  unpublishAt?: string;
  version: number;
}

export interface PlatformDramaRecord {
  categoryId?: string;
  code: string;
  coverMediaAssetId?: string;
  createdAt: string;
  deletedAt?: string;
  episodes?: PlatformEpisodeRecord[];
  id: string;
  releaseAt?: string;
  restoreUntil?: string;
  status:
    | 'approved'
    | 'draft'
    | 'published'
    | 'rejected'
    | 'unpublished';
  tagIds: string[];
  totalEpisodes: number;
  translations: DramaTranslationInput[];
  unpublishAt?: string;
  version: number;
}
