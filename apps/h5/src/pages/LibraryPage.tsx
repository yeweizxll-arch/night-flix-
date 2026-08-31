import { useEffect, useRef, useState } from 'react';

import type { ContentLocale, DramaDetail, FavoriteRecord, PageResponse, WatchProgress } from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';
import { AssetImage, Empty, ErrorState, formatTime, Loading } from '../ui';

export function LibraryPage({ locale }: { locale: ContentLocale }) {
  const { api, principal } = useSession();
  const [favorites, setFavorites] = useState<PageResponse<FavoriteRecord>>();
  const [history, setHistory] = useState<PageResponse<WatchProgress>>();
  const [details, setDetails] = useState<Record<string, DramaDetail>>({});
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    if (!principal) return;
    const current = ++sequence.current; setStatus('loading');
    void Promise.all([
      api.request<PageResponse<FavoriteRecord>>('/api/v1/customer/playback/favorites?page=1&pageSize=50'),
      api.request<PageResponse<WatchProgress>>('/api/v1/customer/playback/history?page=1&pageSize=50'),
    ]).then(async ([favoriteData, historyData]) => {
      if (current !== sequence.current) return;
      setFavorites(favoriteData); setHistory(historyData);
      const ids = [...new Set(historyData.items.map((item) => item.dramaId))];
      const pairs = await Promise.all(ids.map(async (id) => {
        try { return [id, await api.request<DramaDetail>(`/api/v1/customer/content/dramas/${encodeURIComponent(id)}?locale=${encodeURIComponent(locale)}`, { requiresAuth: false })] as const; }
        catch { return undefined; }
      }));
      if (current === sequence.current) {
        setDetails(Object.fromEntries(pairs.filter((value): value is readonly [string, DramaDetail] => Boolean(value))));
        setStatus('ready');
      }
    }).catch(() => { if (current === sequence.current) setStatus('error'); });
  }, [api, locale, principal, reload]);
  if (!principal) return <LoginRequired locale={locale} />;
  if (status === 'loading') return <Loading locale={locale} />;
  if (status === 'error') return <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} />;
  return <main className="page"><h1>{translate(locale, 'favorites')}</h1>
    {!favorites?.items.length ? <Empty locale={locale} /> : <section className="library-list">{favorites.items.map((item) => <article key={item.dramaId}>
      <button className="library-link" onClick={() => navigate({ name: 'drama', dramaId: item.dramaId })}><AssetImage api={api} mediaId={item.coverFileId} alt="" /><span><strong>{item.title ?? item.code}</strong><small>{item.code}</small></span></button>
      <button className="text-button" onClick={() => void api.request(`/api/v1/customer/playback/favorites/${item.dramaId}`, { method: 'DELETE' }).then(() => setReload((value) => value + 1))}>{translate(locale, 'removeFavorite')}</button>
    </article>)}</section>}
    <h2>{translate(locale, 'history')}</h2>
    {!history?.items.length ? <Empty locale={locale} /> : <section className="library-list">{history.items.map((item) => {
      const drama = details[item.dramaId]; const episode = drama?.episodes.find((value) => value.id === item.episodeId);
      return <article key={item.episodeId}><button className="library-link" onClick={() => navigate({ name: 'watch', dramaId: item.dramaId, episodeId: item.episodeId, autoplay: false })}>
        <AssetImage api={api} mediaId={drama?.coverMediaId} alt="" /><span><strong>{drama?.title ?? item.dramaId}</strong><small>{episode ? `${translate(locale, 'episode')} ${episode.episodeNo} · ${episode.title}` : item.episodeId}</small><small>{item.completed ? translate(locale, 'completed') : `${translate(locale, 'resumeAt')} ${formatTime(item.positionSeconds)}`}</small></span>
      </button></article>;
    })}</section>}
  </main>;
}

function LoginRequired({ locale }: { locale: ContentLocale }) {
  return <main className="page state"><p>{translate(locale, 'signInRequired')}</p><button onClick={() => navigate({ name: 'login', returnTo: '#/library' })}>{translate(locale, 'login')}</button></main>;
}
