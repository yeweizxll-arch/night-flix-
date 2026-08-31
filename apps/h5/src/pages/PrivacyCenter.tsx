import { useEffect, useState, type FormEvent } from 'react';

import type {
  ContentLocale,
  LegalConsentRecord,
  PrivacyErasureResponse,
  PrivacyExportSection,
} from '../api/types';
import { translate } from '../i18n';
import { collectPrivacyExport } from '../privacy-export';
import { navigate } from '../router';
import { useSession } from '../session';

const EXPORT_SECTIONS: PrivacyExportSection[] = [
  'profile', 'consents', 'orders', 'comments', 'bulletComments',
  'watchProgress', 'favorites', 'notifications',
];

export function PrivacyCenter({
  locale,
  onErasureSubmitted,
}: {
  locale: ContentLocale;
  onErasureSubmitted: (response: PrivacyErasureResponse) => void;
}) {
  const { api, principal } = useSession();
  const [consents, setConsents] = useState<LegalConsentRecord[]>([]);
  const [consentsError, setConsentsError] = useState(false);
  const [section, setSection] = useState<PrivacyExportSection>('profile');
  const [exportPassword, setExportPassword] = useState('');
  const [erasurePassword, setErasurePassword] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<'erasure' | 'export'>();
  const [error, setError] = useState(false);
  const [erasure, setErasure] = useState<PrivacyErasureResponse>();

  useEffect(() => {
    if (!principal) return;
    let active = true;
    setConsentsError(false);
    void api.request<{ items: LegalConsentRecord[] }>('/api/v1/customer/privacy/consents', {
      cache: 'no-store',
    }).then((response) => { if (active) setConsents(response.items); })
      .catch(() => { if (active) setConsentsError(true); });
    return () => { active = false; };
  }, [api, principal]);

  async function exportData(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy('export'); setError(false);
    try {
      const data = await collectPrivacyExport(api, section, exportPassword);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `my-data-${section}-${new Date().toISOString().slice(0, 10)}.json`;
      link.href = url;
      link.rel = 'noopener';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError(true);
    } finally {
      setExportPassword('');
      setBusy(undefined);
    }
  }

  async function requestErasure(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!acknowledged || confirmText !== 'DELETE') {
      setError(true);
      return;
    }
    setBusy('erasure'); setError(false);
    try {
      const response = await api.request<PrivacyErasureResponse>('/api/v1/customer/privacy/erasure-requests', {
        cache: 'no-store',
        json: { acknowledgeRetention: true, currentPassword: erasurePassword },
        method: 'POST',
      });
      setErasure(response);
      onErasureSubmitted(response);
      setErasurePassword(''); setConfirmText(''); setAcknowledged(false);
      api.clearForAccountErasure();
    } catch {
      setErasurePassword('');
      setError(true);
    } finally {
      setBusy(undefined);
    }
  }

  if (erasure) {
    return <ErasureSubmittedView locale={locale} response={erasure} />;
  }

  return (
    <section className="privacy-center">
      <h2>{translate(locale, 'privacyCenter')}</h2>
      <section className="panel">
        <h3>{translate(locale, 'consentHistory')}</h3>
        {consentsError ? <p className="error">{translate(locale, 'error')}</p> : consents.length ? consents.map((consent) => <button className="consent-history" key={consent.id} onClick={() => navigate({ name: 'legal' })} type="button"><span><strong>{consent.title}</strong><small>{consent.documentType} · {consent.locale} · v{consent.version}</small></span><small>{new Date(consent.consentedAt).toLocaleString(locale)}</small></button>) : <p className="muted">{translate(locale, 'empty')}</p>}
      </section>
      <form className="panel privacy-form" onSubmit={(event) => void exportData(event)}>
        <h3>{translate(locale, 'downloadData')}</h3>
        <label>{translate(locale, 'dataSection')}<select onChange={(event) => setSection(event.target.value as PrivacyExportSection)} value={section}>{EXPORT_SECTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>{translate(locale, 'currentPassword')}<input autoComplete="current-password" maxLength={256} minLength={8} onChange={(event) => setExportPassword(event.target.value)} required type="password" value={exportPassword} /></label>
        <button disabled={busy === 'export'} type="submit">{busy === 'export' ? translate(locale, 'loading') : translate(locale, 'downloadJson')}</button>
        <small>{translate(locale, 'exportNotice')}</small>
      </form>
      <form className="panel privacy-form danger-zone" onSubmit={(event) => void requestErasure(event)}>
        <h3>{translate(locale, 'requestErasure')}</h3>
        <p>{translate(locale, 'erasureWarning')}</p>
        <label><span>{translate(locale, 'currentPassword')}</span><input autoComplete="current-password" maxLength={256} minLength={8} onChange={(event) => setErasurePassword(event.target.value)} required type="password" value={erasurePassword} /></label>
        <label className="check-label"><input checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} type="checkbox" /><span>{translate(locale, 'retentionAcknowledgement')}</span></label>
        <label>{translate(locale, 'typeDelete')}<input autoComplete="off" onChange={(event) => setConfirmText(event.target.value)} required value={confirmText} /></label>
        <button className="danger" disabled={busy === 'erasure' || !acknowledged || confirmText !== 'DELETE'} type="submit">{busy === 'erasure' ? translate(locale, 'loading') : translate(locale, 'submitErasure')}</button>
      </form>
      {error ? <p className="error" role="alert">{translate(locale, 'privacyOperationFailed')}</p> : null}
    </section>
  );
}

export function ErasureSubmittedView({
  locale,
  response,
}: {
  locale: ContentLocale;
  response: PrivacyErasureResponse;
}) {
  return (
    <section className="panel erasure-result">
      <h2>{translate(locale, 'erasureSubmitted')}</h2>
      <p>{translate(locale, 'erasureProcessingNotice')}</p>
      <small>{response.requestId} · {response.status}</small>
      {response.retentionSummary.map((item) => <p key={`${item.category}:${item.reason}`}><strong>{item.category}</strong><br /><small>{item.reason} · {new Date(item.retainedUntil).toLocaleDateString(locale)}</small></p>)}
      {response.subprocessorStatus.length ? <p className="notice">{translate(locale, 'thirdPartyFollowUp')}</p> : null}
      <button onClick={() => navigate({ name: 'home' })}>{translate(locale, 'home')}</button>
    </section>
  );
}
