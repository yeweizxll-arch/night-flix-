import { useEffect, useState, type ImgHTMLAttributes } from 'react';

import type { CustomerApiClient } from './api/client';
import type { AssetUrlResponse, ContentLocale } from './api/types';
import { translate } from './i18n';

export function AssetImage({ api, mediaId, ...props }: ImgHTMLAttributes<HTMLImageElement> & { api: CustomerApiClient; mediaId?: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    setUrl(undefined);
    if (mediaId) {
      void api.request<AssetUrlResponse>(`/api/v1/customer/assets/${encodeURIComponent(mediaId)}/url`, { requiresAuth: false })
        .then((value) => { if (active) setUrl(value.url); })
        .catch(() => undefined);
    }
    return () => { active = false; };
  }, [api, mediaId]);
  if (!url) return <div className={`image-placeholder ${props.className ?? ''}`} aria-hidden="true" />;
  return <img {...props} referrerPolicy="no-referrer" src={url} />;
}

export function Loading({ locale }: { locale: ContentLocale }) {
  return <div className="state" role="status"><span className="spinner" />{translate(locale, 'loading')}</div>;
}

export function Empty({ locale }: { locale: ContentLocale }) {
  return <div className="state muted">{translate(locale, 'empty')}</div>;
}

export function ErrorState({ locale, retry }: { locale: ContentLocale; retry: () => void }) {
  return <div className="state error"><p>{translate(locale, 'error')}</p><button type="button" onClick={retry}>{translate(locale, 'refresh')}</button></div>;
}

export function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${minutes}:${String(rest).padStart(2, '0')}`;
}
