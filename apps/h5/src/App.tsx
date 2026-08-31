import { useEffect, useMemo, useState } from 'react';

import type { AssetUrlResponse, BootstrapResponse, ContentLocale } from './api/types';
import { CONTENT_LOCALES } from './api/types';
import { isContentLocale, localeNames, translate } from './i18n';
import { AccountPage } from './pages/AccountPage';
import { DramaPage } from './pages/DramaPage';
import { HomePage } from './pages/HomePage';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/LoginPage';
import { LegalDocumentsPage } from './pages/LegalDocumentsPage';
import { PaymentResultPage } from './pages/PaymentResultPage';
import { PlayerPage } from './pages/PlayerPage';
import { RegisterPage } from './pages/RegisterPage';
import { IS_TEST_RELEASE } from './release-channel';
import { navigate, parseHashRoute, parseLocationRoute, type AppRoute } from './router';
import { useSession } from './session';
import { AssetImage, ErrorState, Loading } from './ui';

const LOCALE_KEY = 'drama_h5_locale';

export function App() {
  const { api, initializing, principal } = useSession();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [bootstrapError, setBootstrapError] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [route, setRoute] = useState<AppRoute>(() => parseLocationRoute(
    window.location.pathname,
    window.location.search,
    window.location.hash,
  ));
  const [locale, setLocaleState] = useState<ContentLocale>(() => {
    const stored = window.sessionStorage.getItem(LOCALE_KEY);
    return isContentLocale(stored) ? stored : 'zh-CN';
  });
  useEffect(() => {
    const update = () => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    if (
      !window.location.hash
      && window.location.pathname !== '/payment/result'
      && window.location.pathname !== '/payment/cancel'
    ) window.location.hash = '#/';
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let active = true; setBootstrapError(false);
    void api.request<BootstrapResponse>('/api/v1/customer/bootstrap', { requiresAuth: false })
      .then((value) => { if (active) { setBootstrap(value); const stored = window.sessionStorage.getItem(LOCALE_KEY); if (!isContentLocale(stored) || !value.supportedLocales.includes(stored)) setLocaleState(value.defaultLocale); } })
      .catch(() => { if (active) setBootstrapError(true); });
    return () => { active = false; };
  }, [api, bootstrapAttempt]);
  useEffect(() => {
    if (!bootstrap) return;
    const root = document.documentElement;
    root.dataset.theme = bootstrap.theme.colorMode;
    if (/^#[0-9A-Fa-f]{6}$/.test(bootstrap.theme.primaryColor)) root.style.setProperty('--primary', bootstrap.theme.primaryColor);
    if (/^#[0-9A-Fa-f]{6}$/.test(bootstrap.theme.accentColor)) root.style.setProperty('--accent', bootstrap.theme.accentColor);
    document.title = IS_TEST_RELEASE ? `${bootstrap.siteName} · Internal Test` : bootstrap.siteName;
    if (!bootstrap.iconMediaAssetId) return;
    let active = true;
    void api.request<AssetUrlResponse>(`/api/v1/customer/assets/${bootstrap.iconMediaAssetId}/url`, { requiresAuth: false }).then((asset) => {
      if (!active) return;
      let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
      link.href = asset.url;
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, bootstrap]);
  const supported = useMemo(() => bootstrap?.supportedLocales.filter((value) => CONTENT_LOCALES.includes(value)) ?? CONTENT_LOCALES.slice(), [bootstrap]);
  const setLocale = (value: ContentLocale) => { setLocaleState(value); window.sessionStorage.setItem(LOCALE_KEY, value); };
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  if (!bootstrap && !bootstrapError) return <Loading locale={locale} />;
  if (bootstrapError || !bootstrap) return <ErrorState locale={locale} retry={() => setBootstrapAttempt((value) => value + 1)} />;
  return <div className="app-shell">
    {IS_TEST_RELEASE ? <div className="test-banner">{translate(locale, 'internal')}</div> : null}
    {route.name !== 'watch' && <header className="site-header"><button className="brand" onClick={() => navigate({ name: 'home' })}><AssetImage api={api} mediaId={bootstrap.logoMediaAssetId} alt="" /><span>{bootstrap.siteName}</span></button>
      <div className="header-actions"><label className="locale-select"><span className="sr-only">{translate(locale, 'language')}</span><select value={locale} onChange={(event) => setLocale(event.target.value as ContentLocale)}>{supported.map((value) => <option key={value} value={value}>{localeNames[value]}</option>)}</select></label>{!initializing && (principal ? <span className="account-name">{principal.username}</span> : <button className="secondary compact" onClick={() => navigate({ name: 'login', returnTo: window.location.hash })}>{translate(locale, 'login')}</button>)}</div>
    </header>}
    {route.name === 'home' && <HomePage locale={locale} />}
    {route.name === 'drama' && <DramaPage commerceEnabled={bootstrap.capabilities.commerceCatalog} dramaId={route.dramaId} locale={locale} />}
    {route.name === 'watch' && <PlayerPage {...route} commerceEnabled={bootstrap.capabilities.commerceCatalog} locale={locale} />}
    {route.name === 'library' && <LibraryPage locale={locale} />}
    {route.name === 'account' && <AccountPage locale={locale} />}
    {route.name === 'login' && <LoginPage locale={locale} returnTo={route.returnTo} />}
    {route.name === 'register' && <RegisterPage locale={locale} />}
    {route.name === 'legal' && <LegalDocumentsPage locale={locale} />}
    {route.name === 'payment' && (route.orderId
      ? <PaymentResultPage cancelled={route.cancelled} locale={locale} orderId={route.orderId} />
      : <ErrorState locale={locale} retry={() => navigate({ name: 'home' })} />)}
    {route.name !== 'watch' && <nav className="bottom-nav"><button className={route.name === 'home' ? 'active' : ''} onClick={() => navigate({ name: 'home' })}>⌂<span>{translate(locale, 'home')}</span></button><button className={route.name === 'library' ? 'active' : ''} onClick={() => navigate({ name: 'library' })}>♡<span>{translate(locale, 'favorites')}</span></button><button className={route.name === 'account' ? 'active' : ''} onClick={() => navigate({ name: 'account' })}>◎<span>{translate(locale, 'account')}</span></button></nav>}
  </div>;
}
