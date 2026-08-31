import { useEffect, useState } from 'react';

import type { AccountSummary, ContentLocale, DeviceListResponse, PrivacyErasureResponse } from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';
import { ErrorState, Loading } from '../ui';
import { ErasureSubmittedView, PrivacyCenter } from './PrivacyCenter';

export function AccountPage({ locale }: { locale: ContentLocale }) {
  const { api, logout, principal } = useSession();
  const [account, setAccount] = useState<AccountSummary>();
  const [devices, setDevices] = useState<DeviceListResponse>();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [reload, setReload] = useState(0);
  const [erasure, setErasure] = useState<PrivacyErasureResponse>();
  useEffect(() => {
    if (!principal) return;
    let active = true; setStatus('loading');
    void Promise.all([
      api.request<AccountSummary>('/api/v1/customer/account/me'),
      api.request<DeviceListResponse>('/api/v1/customer/account/devices'),
    ]).then(([nextAccount, nextDevices]) => { if (active) { setAccount(nextAccount); setDevices(nextDevices); setStatus('ready'); } })
      .catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [api, principal, reload]);
  if (erasure) return <main className="page narrow"><ErasureSubmittedView locale={locale} response={erasure} /></main>;
  if (!principal) return <main className="page state"><p>{translate(locale, 'signInRequired')}</p><button onClick={() => navigate({ name: 'login', returnTo: '#/account' })}>{translate(locale, 'login')}</button></main>;
  if (status === 'loading') return <Loading locale={locale} />;
  if (status === 'error' || !account) return <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} />;
  return <main className="page narrow"><h1>{translate(locale, 'accountSummary')}</h1><section className="panel account-summary"><strong>{account.username}</strong>
    {account.email && <p>{account.email.masked} {account.email.verified && <span className="badge">{translate(locale, 'verified')}</span>}</p>}
    {account.phone && <p>{account.phone.masked} {account.phone.verified && <span className="badge">{translate(locale, 'verified')}</span>}</p>}
  </section><h2>{translate(locale, 'devices')}</h2><section className="panel device-list">{devices?.items.map((device) => <div key={device.id}><span><strong>{device.label || device.platform}</strong><small>{new Date(device.lastSeenAt).toLocaleString(locale)}</small></span>{!device.current && <button type="button" className="secondary" onClick={() => void api.request(`/api/v1/customer/account/devices/${device.id}/revoke`, { method: 'POST' }).then(() => setReload((value) => value + 1))}>{translate(locale, 'revoke')}</button>}</div>)}</section>
    <PrivacyCenter locale={locale} onErasureSubmitted={setErasure} />
    <button type="button" className="danger" onClick={() => void logout().finally(() => navigate({ name: 'home' }))}>{translate(locale, 'logout')}</button>
  </main>;
}
