export type AppBuildTarget = 'android_debug' | 'ios_simulator';
export type AppBuildStatus = 'cancelled' | 'failed' | 'processing' | 'queued' | 'succeeded';

export interface AppBuildMutationMetadata {
  actorId: string;
  idempotencyKey: string;
  ip?: string;
  requestId: string;
}

export type AppBuildDownloadMetadata = Omit<AppBuildMutationMetadata, 'idempotencyKey'>;

export interface AppBuildProfileRecord {
  androidApplicationId: string;
  appName: string;
  createdAt: string;
  h5DomainId: string;
  h5Host: string;
  iconMediaAssetId: string;
  id: string;
  iosBundleId: string;
  splashMediaAssetId?: string;
  tenantId: string;
  updatedAt: string;
  version: number;
}

export interface UpsertAppBuildProfileInput {
  androidApplicationId: string;
  appName: string;
  expectedVersion: number | null;
  h5DomainId: string;
  iconMediaAssetId: string;
  iosBundleId: string;
  splashMediaAssetId?: string | null;
}

export interface CreateAppBuildJobInput {
  expectedProfileVersion: number;
  target: AppBuildTarget;
}

export interface AppBuildJobRecord {
  artifact?: {
    contentType: 'application/vnd.android.package-archive' | 'application/zip';
    filename: string;
    sizeBytes: string;
  };
  completedAt?: string;
  createdAt: string;
  failureCode?: string;
  id: string;
  profileId: string;
  profileVersion: number;
  releaseChannel: 'internal_test';
  startedAt?: string;
  status: AppBuildStatus;
  target: AppBuildTarget;
  tenantId: string;
  version: number;
}
