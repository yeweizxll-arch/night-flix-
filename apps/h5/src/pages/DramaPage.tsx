import { useEffect, useState } from 'react';

import type { ContentLocale, DramaDetail } from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';
import { AssetImage, Empty, ErrorState, formatTime, Loading } from '../ui';
import { CommerceCheckout } from './CommerceCheckout';

export function DramaPage({
  commerceEnabled,
  dramaId,
  locale,
}: {
  commerceEnabled: boolean;
  dramaId: string;
  locale: ContentLocale;
}) {
  const { api, principal } = useSession();
  const [drama, setDrama] = useState<DramaDetail>();
  const [favorite, setFavorite] = useState(false);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setStatus('loading');
    void api.request<DramaDetail>(`/api/v1/customer/content/dramas/${encodeURIComponent(dramaId)}?locale=${encodeURIComponent(locale)}`, { requiresAuth: false })
      .then((value) => { if (active) { setDrama(value); setStatus('ready'); } })
      .catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [api, dramaId, locale, reload]);
  useEffect(() => {
    if (!principal) { setFavorite(false); return; }
    let active = true;
    void api.request<{ items: Array<{ dramaId: string }> }>('/api/v1/customer/playback/favorites?page=1&pageSize=100')
      .then((value) => { if (active) setFavorite(value.items.some((item) => item.dramaId === dramaId)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [api, dramaId, principal]);
  if (status === 'loading') return <Loading locale={locale} />;
  if (status === 'error' || !drama) return <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} />;
  return <main className="page drama-detail">
    <button type="button" className="text-button" onClick={() => navigate({ name: 'home' })}>← {translate(locale, 'back')}</button>
    <section className="detail-hero">
      <AssetImage api={api} mediaId={drama.coverMediaId} alt="" className="detail-cover" />
      <div><p className="eyebrow">{drama.code}</p><h1>{drama.title}</h1><p>{drama.summary}</p>
        <button type="button" className="secondary" onClick={() => {
          if (!principal) { navigate({ name: 'login', returnTo: window.location.hash }); return; }
          const method = favorite ? 'DELETE' : 'POST';
          void api.request(`/api/v1/customer/playback/favorites/${encodeURIComponent(drama.id)}`, { method }).then(() => setFavorite(!favorite));
        }}>{favorite ? translate(locale, 'removeFavorite') : translate(locale, 'favorite')}</button>
      </div>
    </section>
    <CommerceCheckout
      enabled={commerceEnabled}
      locale={locale}
      productId={drama.id}
      productType="drama"
    />
    <h2>{translate(locale, 'episodes')}</h2>
    {drama.episodes.length === 0 ? <Empty locale={locale} /> : <section className="episode-grid">
      {drama.episodes.map((episode) => <button type="button" key={episode.id} onClick={() => {
        if (!principal) navigate({ name: 'login', returnTo: `#/watch/${drama.id}/${episode.id}` });
        else navigate({ name: 'watch', dramaId: drama.id, episodeId: episode.id, autoplay: false });
      }}><strong>{translate(locale, 'episode')} {episode.episodeNo}</strong><span>{episode.title}</span><small>{formatTime(episode.durationSeconds)}</small></button>)}
    </section>}
  </main>;
}
