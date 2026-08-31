import { ApiError } from '../api/http';

export interface EpisodeMediaValues {
  mediaAssetId: string;
  previewMediaAssetId?: string;
}

export function episodeMediaValues(
  mainValue: string,
  previewValue: string | undefined,
  isUuid: (value: string) => boolean,
): EpisodeMediaValues {
  const mediaAssetId = mainValue.trim();
  const previewMediaAssetId = previewValue?.trim() || undefined;
  if (!isUuid(mediaAssetId)) throw new Error('正片 Media Asset ID 必须是 UUID');
  if (previewMediaAssetId && !isUuid(previewMediaAssetId)) {
    throw new Error('试看 Media Asset ID 必须是 UUID');
  }
  if (previewMediaAssetId === mediaAssetId) {
    throw new Error('试看必须使用与正片不同的独立视频，不能复制或回退到正片');
  }
  return { mediaAssetId, previewMediaAssetId };
}

export function previewMediaPatch(
  current: string | undefined,
  next: string | undefined,
): { changed: false } | { changed: true; value: string | null } {
  const currentValue = current || undefined;
  const nextValue = next || undefined;
  return currentValue === nextValue
    ? { changed: false }
    : { changed: true, value: nextValue ?? null };
}

export function canUploadEpisodeMedia(
  scope: 'platform' | 'tenant',
  permissions: readonly string[],
): boolean {
  return scope === 'platform'
    ? permissions.includes('platform.content.manage')
    : permissions.includes('content.drama.create');
}

export function isContentVersionConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}

export function episodeConflictRefreshPlan(reason: unknown): {
  closeEditor: true;
  refreshDetail: true;
  refreshList: true;
} | undefined {
  return isContentVersionConflict(reason)
    ? { closeEditor: true, refreshDetail: true, refreshList: true }
    : undefined;
}
