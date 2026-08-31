import { describe, expect, it } from 'vitest';

import type { DramaEpisode } from './api/types';
import { nextEpisode, previewPosition, renewalDelay, shouldReportProgress, shouldResumeSource } from './player-utils';

const episode = (id: string, episodeNo: number): DramaEpisode => ({ durationSeconds: 60, episodeNo, id, locale: 'en-US', mediaAssetId: id, previewSeconds: 0, title: id });

describe('player helpers', () => {
  it('selects the next ordered episode without wrapping', () => {
    const episodes = [episode('one', 1), episode('two', 2)];
    expect(nextEpisode(episodes, 'one')?.id).toBe('two');
    expect(nextEpisode(episodes, 'two')).toBeUndefined();
  });

  it('throttles progress and renews signed URLs before expiry', () => {
    expect(shouldReportProgress(5, 14)).toBe(false);
    expect(shouldReportProgress(5, 15)).toBe(true);
    expect(renewalDelay('2026-01-01T00:02:00.000Z', Date.parse('2026-01-01T00:00:00.000Z'))).toBe(90_000);
  });

  it('resumes renewal only when playback was active and applies autoplay only on first load', () => {
    expect(shouldResumeSource(true, false, false)).toBe(true);
    expect(shouldResumeSource(false, false, true)).toBe(false);
    expect(shouldResumeSource(false, true, true)).toBe(true);
  });

  it('clamps preview playback at the trusted access limit', () => {
    expect(previewPosition(8.4, 10)).toEqual({ positionSeconds: 8.4, reachedLimit: false });
    expect(previewPosition(10.2, 10)).toEqual({ positionSeconds: 10, reachedLimit: true });
  });
});
