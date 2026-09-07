export interface ContentMutationMetadata {
  actorId: string;
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface DramaTranslationInput {
  locale: string;
  searchKeywords?: string[];
  summary?: string;
  title: string;
}

export interface CreateDramaInput {
  categoryId?: string;
  code: string;
  coverFileId?: string;
  releaseAt?: string;
  sourceType?: 'upload';
  tagIds?: string[];
  translations: DramaTranslationInput[];
  unpublishAt?: string;
}

export interface CreateEpisodeInput {
  durationSeconds: number;
  episodeNo: number;
  expectedDramaVersion: number;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds?: number;
  releaseAt?: string;
  translations: Array<{ locale: string; title: string }>;
  unpublishAt?: string;
}

export interface UpdateDramaInput {
  categoryId?: string | null;
  code?: string;
  coverFileId?: string | null;
  expectedVersion?: number;
  releaseAt?: string | null;
  translations?: DramaTranslationInput[];
  tagIds?: string[];
  unpublishAt?: string | null;
  version?: number;
}

export interface UpdateEpisodeInput {
  durationSeconds?: number;
  episodeNo?: number;
  expectedVersion: number;
  mediaAssetId?: string;
  previewMediaAssetId?: string | null;
  previewSeconds?: number;
  releaseAt?: string | null;
  translations?: Array<{ locale: string; title: string }>;
  unpublishAt?: string | null;
}

export interface EpisodeRecord {
  tracks?: EpisodeTrackRecord[];
  dramaId: string;
  durationSeconds: number;
  episodeNo: number;
  id: string;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
  releaseAt?: string;
  status: 'approved' | 'draft' | 'published' | 'unpublished';
  translations: Array<{ locale: string; title: string }>;
  unpublishAt?: string;
  version: number;
}

export interface EpisodeTrackRecord {
  id: string;
  type: 'subtitle' | 'dubbing';
  locale: string;
  label: string;
  mediaAssetId: string;
  isDefault: boolean;
  status: 'active' | 'disabled';
}

export interface DramaRecord {
  categoryId?: string;
  code: string;
  coverFileId?: string;
  createdAt: string;
  deletedAt?: string;
  id: string;
  releaseAt?: string;
  restoreUntil?: string;
  sourceType: 'import' | 'upload' | 'url';
  status:
    | 'approved'
    | 'draft'
    | 'pending_review'
    | 'published'
    | 'rejected'
    | 'unpublished';
  totalEpisodes: number;
  tagIds: string[];
  translations: DramaTranslationInput[];
  unpublishAt?: string;
  version: number;
}

export interface ReviewDecisionInput {
  reason?: string;
  version: number;
}

export interface DeleteTenantDramaInput {
  expectedVersion: number;
  reason: string;
}

export interface ExpectedTenantContentVersionInput {
  expectedVersion: number;
}
