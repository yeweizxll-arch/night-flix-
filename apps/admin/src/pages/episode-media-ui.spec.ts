import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/http';
import {
  canUploadEpisodeMedia,
  episodeConflictRefreshPlan,
  episodeMediaValues,
  isContentVersionConflict,
  previewMediaPatch,
} from './episode-media-ui';

const mainId = '018f6f18-6d29-7d85-8f39-91a713913f4b';
const previewId = '018f6f18-6d29-7d85-8f39-91a713913f4c';
const isUuid = (value: string) => [mainId, previewId].includes(value);

describe('independent episode preview UI', () => {
  it('normalizes independent media IDs and rejects a full-video fallback', () => {
    expect(episodeMediaValues(` ${mainId} `, ` ${previewId} `, isUuid)).toEqual({
      mediaAssetId: mainId,
      previewMediaAssetId: previewId,
    });
    expect(() => episodeMediaValues(mainId, mainId, isUuid)).toThrow(/不同的独立视频/);
    expect(() => episodeMediaValues(mainId, 'not-a-uuid', isUuid)).toThrow(/试看.*UUID/);
  });

  it('emits null only when an existing preview is explicitly cleared', () => {
    expect(previewMediaPatch(previewId, undefined)).toEqual({ changed: true, value: null });
    expect(previewMediaPatch(undefined, previewId)).toEqual({ changed: true, value: previewId });
    expect(previewMediaPatch(previewId, previewId)).toEqual({ changed: false });
  });

  it('uses exact scope permissions for secure uploads', () => {
    expect(canUploadEpisodeMedia('platform', ['platform.content.manage'])).toBe(true);
    expect(canUploadEpisodeMedia('platform', ['platform.content.read'])).toBe(false);
    expect(canUploadEpisodeMedia('tenant', ['content.drama.create'])).toBe(true);
    expect(canUploadEpisodeMedia('tenant', ['content.drama.update'])).toBe(false);
  });

  it('treats only HTTP 409 as a refresh-required version conflict', () => {
    expect(isContentVersionConflict(new ApiError('conflict', 409))).toBe(true);
    expect(episodeConflictRefreshPlan(new ApiError('conflict', 409))).toEqual({
      closeEditor: true,
      refreshDetail: true,
      refreshList: true,
    });
    expect(episodeConflictRefreshPlan(new ApiError('forbidden', 403))).toBeUndefined();
    expect(isContentVersionConflict(new ApiError('bad request', 400))).toBe(false);
    expect(isContentVersionConflict(new Error('409'))).toBe(false);
  });
});
