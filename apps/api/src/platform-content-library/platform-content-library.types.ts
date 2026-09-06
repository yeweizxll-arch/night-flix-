import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
export const CONTENT_LOCALES = SUPPORTED_APP_LOCALES;

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
  shanchuangCreatorId?: string;
  shanchuangWorkId?: string;
  publicRevision?: number;
  supersedesDramaId?: string;
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

export interface UpsertPlatformEpisodeTrackInput {
  expectedDramaVersion: number;
  isDefault?: boolean;
  label: string;
  locale: string;
  mediaAssetId: string;
  type: 'dubbing' | 'subtitle';
}

export interface PlatformEpisodeTrackRecord {
  id: string;
  isDefault: boolean;
  label: string;
  locale: string;
  mediaAssetId: string;
  status: 'active' | 'disabled';
  type: 'dubbing' | 'subtitle';
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
  tracks: PlatformEpisodeTrackRecord[];
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
  publicReleaseLockedAt?: string;
  publicRevision?: number;
  shanchuangCreatorId?: string;
  shanchuangWorkId?: string;
  supersedesDramaId?: string;
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
