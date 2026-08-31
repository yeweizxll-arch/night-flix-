export type PublicDramaPublicationStatus =
  | 'pending_review'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'unpublished';

export interface PublicDramaPoolMutationMetadata {
  actorId: string;
  ip?: string;
  requestId: string;
}

export interface ReviewPublicDramaInput {
  decision: 'approved' | 'rejected';
  expectedVersion?: number;
  note?: string;
}

export interface EpisodePointPriceInput {
  episodeId: string;
  points: number;
}

export interface PublishPublicDramaInput {
  allowedCountries?: string[];
  blockedCountries?: string[];
  dramaPoints?: number;
  episodePoints?: EpisodePointPriceInput[];
  expectedVersion: number;
}

export interface UnpublishPublicDramaInput {
  expectedVersion: number;
}

export interface EmergencyTakedownInput {
  expectedVersion: number;
  reason: string;
}

export interface TenantAppRuntimeConfigInput {
  admob?: Record<string, unknown>;
  allowedCountries?: string[];
  deepLinkHost?: string | null;
  expectedVersion: number;
  featureFlags?: Record<string, unknown>;
  storeProducts?: Record<string, unknown>;
  supportedLocales?: string[];
}
