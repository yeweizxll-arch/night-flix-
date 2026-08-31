import type { DramaEpisode } from './api/types';

export const PROGRESS_INTERVAL_SECONDS = 10;

export function nextEpisode(episodes: DramaEpisode[], currentId: string): DramaEpisode | undefined {
  const index = episodes.findIndex((episode) => episode.id === currentId);
  return index >= 0 ? episodes[index + 1] : undefined;
}

export function shouldReportProgress(lastSeconds: number, currentSeconds: number): boolean {
  return Math.abs(currentSeconds - lastSeconds) >= PROGRESS_INTERVAL_SECONDS;
}

export function renewalDelay(expiresAt: string, now = Date.now()): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return 60_000;
  return Math.max(5_000, expiry - now - 30_000);
}

export function shouldResumeSource(wasPlaying: boolean, firstLoad: boolean, requestedAutoplay: boolean): boolean {
  return wasPlaying || (firstLoad && requestedAutoplay);
}

export function previewPosition(positionSeconds: number, previewSeconds: number): {
  positionSeconds: number;
  reachedLimit: boolean;
} {
  const maximum = Math.max(0, previewSeconds);
  return {
    positionSeconds: Math.min(Math.max(0, positionSeconds), maximum),
    reachedLimit: positionSeconds >= maximum,
  };
}
