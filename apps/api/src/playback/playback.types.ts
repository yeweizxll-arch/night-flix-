export interface UpsertWatchProgressInput {
  completed?: boolean;
  dramaId: string;
  episodeId: string;
  positionSeconds: number;
}

export interface WatchProgressRecord {
  completed: boolean;
  dramaId: string;
  episodeId: string;
  positionSeconds: number;
  updatedAt: string;
  version: number;
}

export interface FavoriteDramaRecord {
  code: string;
  coverFileId?: string;
  createdAt: string;
  dramaId: string;
  title?: string;
}

export type CustomerPlaybackAccess = 'full' | 'locked' | 'preview';

export interface CustomerPlaybackAccessRecord {
  access: CustomerPlaybackAccess;
  dramaId: string;
  durationSeconds: number;
  episodeId: string;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
}
/** Guests may read free/preview content, but never obtain account entitlements. */
export interface PlaybackViewer { tenantId: string; accountId?: string }
