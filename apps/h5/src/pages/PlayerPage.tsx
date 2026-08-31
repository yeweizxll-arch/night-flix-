import { useCallback, useEffect, useRef, useState } from 'react';

import type { ContentLocale, DramaDetail, PlaybackAccess, PlaybackUrl, WatchProgress } from '../api/types';
import { translate } from '../i18n';
import { nextEpisode, previewPosition, renewalDelay, shouldReportProgress, shouldResumeSource } from '../player-utils';
import { navigate } from '../router';
import { useSession } from '../session';
import { ErrorState, Loading } from '../ui';
import { CommerceCheckout } from './CommerceCheckout';

export function PlayerPage({ autoplay: initialAutoplay, commerceEnabled, dramaId, episodeId, locale }: { autoplay: boolean; commerceEnabled: boolean; dramaId: string; episodeId: string; locale: ContentLocale }) {
  const { api, principal } = useSession();
  const [drama, setDrama] = useState<DramaDetail>();
  const [access, setAccess] = useState<PlaybackAccess>();
  const [playback, setPlayback] = useState<PlaybackUrl>();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [autoPlay, setAutoPlay] = useState(initialAutoplay);
  const [reload, setReload] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const desiredPosition = useRef(0);
  const desiredPlaying = useRef(false);
  const hasLoadedSource = useRef(false);
  const lastReported = useRef(0);
  const completionRef = useRef(false);
  const urlSequence = useRef(0);
  const current = drama?.episodes.find((episode) => episode.id === episodeId);

  const loadUrl = useCallback(async (expectedAccess: 'full' | 'preview', expectedMediaAssetId: string) => {
    const sequence = ++urlSequence.current;
    const response = await api.request<PlaybackUrl>(`/api/v1/customer/playback/episodes/${encodeURIComponent(episodeId)}/url?expiresInSeconds=300`);
    if (response.access !== expectedAccess || response.mediaAssetId !== expectedMediaAssetId) throw new Error('Playback asset mismatch');
    if (sequence !== urlSequence.current) return;
    desiredPlaying.current = shouldResumeSource(Boolean(video.current && !video.current.paused), !hasLoadedSource.current, initialAutoplay);
    desiredPosition.current = video.current?.currentTime ?? desiredPosition.current;
    setPlayback(response);
  }, [api, episodeId, initialAutoplay]);

  useEffect(() => {
    if (!principal) return;
    let active = true; urlSequence.current += 1; setStatus('loading'); setPlayback(undefined); setAccess(undefined); desiredPosition.current = 0; desiredPlaying.current = false; hasLoadedSource.current = false; lastReported.current = 0; completionRef.current = false;
    void Promise.all([
      api.request<DramaDetail>(`/api/v1/customer/content/dramas/${encodeURIComponent(dramaId)}?locale=${encodeURIComponent(locale)}`, { requiresAuth: false }),
      api.request<PlaybackAccess>(`/api/v1/customer/playback/episodes/${encodeURIComponent(episodeId)}/access`),
      api.request<{ items: WatchProgress[] }>('/api/v1/customer/playback/history?page=1&pageSize=100'),
    ]).then(async ([nextDrama, nextAccess, history]) => {
      if (!active) return;
      setDrama(nextDrama); setAccess(nextAccess);
      const progress = history.items.find((item) => item.episodeId === episodeId);
      desiredPosition.current = progress?.positionSeconds ?? 0; lastReported.current = desiredPosition.current;
      if (nextAccess.access === 'full') await loadUrl('full', nextAccess.mediaAssetId);
      if (nextAccess.access === 'preview' && nextAccess.previewMediaAssetId) await loadUrl('preview', nextAccess.previewMediaAssetId);
      if (active) setStatus('ready');
    }).catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [api, dramaId, episodeId, loadUrl, locale, principal, reload]);

  useEffect(() => {
    if (!playback) return;
    if (!access || access.access === 'locked') return;
    const expectedAccess = access.access;
    const expectedMediaId = expectedAccess === 'preview' ? access.previewMediaAssetId : access.mediaAssetId;
    if (!expectedMediaId) return;
    const timer = window.setTimeout(() => void loadUrl(expectedAccess, expectedMediaId).catch(() => setStatus('error')), renewalDelay(playback.expiresAt));
    return () => window.clearTimeout(timer);
  }, [access, loadUrl, playback]);

  const report = useCallback((isCompleted = false, force = false) => {
    const player = video.current;
    if (!player || !access || access.access === 'locked') return;
    const rawPosition = Math.max(0, Math.floor(player.currentTime));
    const position = access.access === 'preview'
      ? previewPosition(rawPosition, access.previewSeconds).positionSeconds
      : Math.min(rawPosition, access.durationSeconds);
    if (!force && !shouldReportProgress(lastReported.current, position)) return;
    lastReported.current = position;
    if (isCompleted && access.access === 'full') completionRef.current = true;
    void api.request<WatchProgress>('/api/v1/customer/playback/progress', { keepalive: force, json: { completed: access.access === 'full' && completionRef.current, dramaId, episodeId, positionSeconds: position }, method: 'PUT' }).catch(() => undefined);
  }, [access, api, dramaId, episodeId]);

  useEffect(() => {
    const pageHide = () => report(false, true);
    const visibility = () => { if (document.visibilityState === 'hidden') report(false, true); };
    window.addEventListener('pagehide', pageHide); document.addEventListener('visibilitychange', visibility);
    return () => { pageHide(); window.removeEventListener('pagehide', pageHide); document.removeEventListener('visibilitychange', visibility); };
  }, [report]);

  if (!principal) return <main className="page state"><p>{translate(locale, 'signInRequired')}</p><button onClick={() => navigate({ name: 'login', returnTo: window.location.hash })}>{translate(locale, 'login')}</button></main>;
  if (status === 'loading') return <Loading locale={locale} />;
  if (status === 'error' || !access || !drama || !current) return <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} />;
  if (access.access === 'preview' && !playback) return <main className="page state"><p>{translate(locale, 'previewUnavailable')}</p><button onClick={() => navigate({ name: 'drama', dramaId })}>{translate(locale, 'back')}</button></main>;
  if (access.access === 'locked') return <main className="page narrow"><button className="text-button" onClick={() => navigate({ name: 'drama', dramaId })}>← {translate(locale, 'back')}</button><div className="notice">{translate(locale, 'locked')}</div><CommerceCheckout enabled={commerceEnabled} locale={locale} productId={episodeId} productType="episode" /></main>;
  return <main className="player-page"><header><button className="text-button" onClick={() => navigate({ name: 'drama', dramaId })}>← {translate(locale, 'back')}</button><div><strong>{drama.title}</strong><small>{translate(locale, 'episode')} {current.episodeNo} · {current.title}</small></div></header>
    <div className="video-shell">{playback ? <video ref={video} src={playback.url} controls controlsList="nodownload" playsInline onLoadedMetadata={() => { hasLoadedSource.current = true; if (video.current && desiredPosition.current > 0) video.current.currentTime = access.access === 'preview' ? previewPosition(desiredPosition.current, access.previewSeconds).positionSeconds : desiredPosition.current; if (video.current && desiredPlaying.current) void video.current.play().catch(() => undefined); }} onTimeUpdate={() => { if (access.access === 'preview' && video.current) { const bounded = previewPosition(video.current.currentTime, access.previewSeconds); if (bounded.reachedLimit) { if (video.current.currentTime > bounded.positionSeconds) video.current.currentTime = bounded.positionSeconds; if (!video.current.paused) video.current.pause(); report(false, true); return; } } report(); }} onPause={() => report(false, true)} onEnded={() => {
      if (access.access === 'full') { completionRef.current = true; report(true, true); const next = nextEpisode(drama.episodes, episodeId); if (autoPlay && next) navigate({ name: 'watch', dramaId, episodeId: next.id, autoplay: true }); }
      else report(false, true);
    }} /> : <Loading locale={locale} />}</div>
    <section className="player-controls"><label>{translate(locale, 'speed')}<select defaultValue="1" onChange={(event) => { if (video.current) video.current.playbackRate = Number(event.target.value); }}>{[0.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
      <label className="toggle"><input type="checkbox" checked={autoPlay} onChange={(event) => setAutoPlay(event.target.checked)} />{translate(locale, 'autoPlay')}</label>
      <button type="button" className="secondary" onClick={() => { const player = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null; if (player?.requestFullscreen) void player.requestFullscreen(); else player?.webkitEnterFullscreen?.(); }}>{translate(locale, 'fullScreen')}</button>
    </section>
    <section className="episode-strip">{drama.episodes.map((episode) => <button type="button" className={episode.id === episodeId ? 'active' : ''} key={episode.id} onClick={() => { report(false, true); navigate({ name: 'watch', dramaId, episodeId: episode.id, autoplay: false }); }}>{episode.episodeNo}</button>)}</section>
  </main>;
}
