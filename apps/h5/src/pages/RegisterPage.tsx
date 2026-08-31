import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  ContentLocale,
  CurrentLegalDocumentsResponse,
  LegalDocument,
  OtpChallengeResponse,
  OtpVerificationResponse,
} from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { SafeMarkdown } from '../safe-markdown';
import { useSession } from '../session';
import { ErrorState, Loading } from '../ui';

type ContactChannel = 'email' | 'phone';

export function RegisterPage({ locale }: { locale: ContentLocale }) {
  const { api, principal } = useSession();
  const [documents, setDocuments] = useState<LegalDocument[]>([]);
  const [documentsState, setDocumentsState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [documentsReload, setDocumentsReload] = useState(0);
  const [expandedDocument, setExpandedDocument] = useState<string>();
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [channel, setChannel] = useState<ContactChannel>('email');
  const [destination, setDestination] = useState('');
  const [challenge, setChallenge] = useState<OtpChallengeResponse>();
  const [code, setCode] = useState('');
  const [verificationToken, setVerificationToken] = useState<string>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState<'otp' | 'register' | 'verify'>();
  const [error, setError] = useState(false);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    let active = true;
    setDocumentsState('loading');
    void api.request<CurrentLegalDocumentsResponse>(
      `/api/v1/customer/legal/documents/current?locale=${encodeURIComponent(locale)}`,
      { cache: 'no-store', requiresAuth: false },
    ).then((response) => {
      if (!active) return;
      setDocuments(response.documents);
      setAccepted(new Set());
      setDocumentsState('ready');
    }).catch(() => { if (active) setDocumentsState('error'); });
    return () => { active = false; };
  }, [api, documentsReload, locale]);

  useEffect(() => {
    setChallenge(undefined);
    setCode('');
    setVerificationToken(undefined);
    setError(false);
  }, [channel, destination]);

  const requiredDocuments = useMemo(
    () => documents.filter((document) => document.documentType === 'privacy'
      || document.documentType === 'terms'
      || document.requiredForRegistration),
    [documents],
  );
  const documentsAvailable = documents.some((item) => item.documentType === 'privacy')
    && documents.some((item) => item.documentType === 'terms');
  const allRequiredAccepted = documentsAvailable
    && requiredDocuments.every((document) => accepted.has(consentKey(document)));

  if (principal) return <main className="page state"><p>{principal.username}</p><button onClick={() => navigate({ name: 'home' })}>{translate(locale, 'home')}</button></main>;
  if (documentsState === 'loading') return <Loading locale={locale} />;
  if (documentsState === 'error') return <ErrorState locale={locale} retry={() => setDocumentsReload((value) => value + 1)} />;
  if (registered) {
    return <main className="page narrow state"><h1>{translate(locale, 'registrationComplete')}</h1><p>{translate(locale, 'registrationLoginNext')}</p><button onClick={() => navigate({ name: 'login' })}>{translate(locale, 'login')}</button></main>;
  }

  async function sendOtp(): Promise<void> {
    setBusy('otp'); setError(false); setChallenge(undefined); setVerificationToken(undefined);
    try {
      const response = await api.request<OtpChallengeResponse>('/api/v1/customer/auth/otp/challenges', {
        cache: 'no-store',
        json: {
          channel,
          destination: destination.trim(),
          purpose: channel === 'email' ? 'verify_email' : 'verify_phone',
        },
        method: 'POST',
        requiresAuth: false,
      });
      setChallenge(response);
    } catch {
      setError(true);
    } finally {
      setBusy(undefined);
    }
  }

  async function verifyOtp(): Promise<void> {
    if (!challenge) return;
    setBusy('verify'); setError(false);
    try {
      const response = await api.request<OtpVerificationResponse>('/api/v1/customer/auth/otp/verify', {
        cache: 'no-store',
        json: {
          challengeId: challenge.challengeId,
          channel,
          code: code.trim(),
          destination: destination.trim(),
          purpose: channel === 'email' ? 'verify_email' : 'verify_phone',
        },
        method: 'POST',
        requiresAuth: false,
      });
      if (!response.verificationToken) throw new Error('Registration verification token missing');
      setVerificationToken(response.verificationToken);
      setCode('');
    } catch {
      setError(true);
    } finally {
      setBusy(undefined);
    }
  }

  async function register(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!verificationToken || !allRequiredAccepted || password !== confirmPassword) {
      setError(true);
      return;
    }
    setBusy('register'); setError(false);
    try {
      const selectedConsents = documents
        .filter((document) => accepted.has(consentKey(document)))
        .map((document) => ({ documentId: document.id, version: document.version }));
      await api.request('/api/v1/customer/auth/register', {
        cache: 'no-store',
        json: {
          ...(channel === 'email'
            ? { email: destination.trim(), emailVerificationToken: verificationToken }
            : { phone: destination.trim(), phoneVerificationToken: verificationToken }),
          legalConsents: selectedConsents,
          legalLocale: locale,
          password,
          username: username.trim().toLowerCase(),
        },
        method: 'POST',
        requiresAuth: false,
      });
      setPassword(''); setConfirmPassword(''); setVerificationToken(undefined); setCode('');
      setRegistered(true);
    } catch {
      setError(true);
      setDocumentsReload((value) => value + 1);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="page narrow auth-card register-page">
      <button className="text-button" onClick={() => navigate({ name: 'login' })}>← {translate(locale, 'back')}</button>
      <h1>{translate(locale, 'register')}</h1>
      <form onSubmit={(event) => void register(event)}>
        <label>{translate(locale, 'accountName')}<input autoComplete="username" maxLength={64} minLength={3} onChange={(event) => setUsername(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,63}" required value={username} /></label>
        <label>{translate(locale, 'password')}<input autoComplete="new-password" maxLength={256} minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
        <label>{translate(locale, 'confirmPassword')}<input autoComplete="new-password" maxLength={256} minLength={8} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></label>
        {confirmPassword && password !== confirmPassword ? <p className="error">{translate(locale, 'passwordMismatch')}</p> : null}
        <fieldset>
          <legend>{translate(locale, 'verifyContact')}</legend>
          <div className="segmented">
            <button className={channel === 'email' ? 'active' : ''} onClick={() => setChannel('email')} type="button">Email</button>
            <button className={channel === 'phone' ? 'active' : ''} onClick={() => setChannel('phone')} type="button">SMS</button>
          </div>
          <label>{channel === 'email' ? 'Email' : translate(locale, 'phone')}<input autoComplete={channel === 'email' ? 'email' : 'tel'} onChange={(event) => setDestination(event.target.value)} placeholder={channel === 'phone' ? '+819012345678' : 'name@example.com'} required type={channel === 'email' ? 'email' : 'tel'} value={destination} /></label>
          {!challenge && !verificationToken ? <button disabled={busy === 'otp'} onClick={() => void sendOtp()} type="button">{busy === 'otp' ? translate(locale, 'loading') : translate(locale, 'sendCode')}</button> : null}
          {challenge && !verificationToken ? <><small>{challenge.deliveryRequired ? translate(locale, 'codeSent') : translate(locale, 'codePrepared')} · {new Date(challenge.expiresAt).toLocaleTimeString(locale)}</small><label>{translate(locale, 'verificationCode')}<input autoComplete="one-time-code" inputMode="numeric" maxLength={8} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} pattern="[0-9]{4,8}" required value={code} /></label><button disabled={busy === 'verify'} onClick={() => void verifyOtp()} type="button">{busy === 'verify' ? translate(locale, 'loading') : translate(locale, 'verify')}</button></> : null}
          {verificationToken ? <p className="success-text">{translate(locale, 'contactVerified')}</p> : null}
        </fieldset>
        <fieldset>
          <legend>{translate(locale, 'legalConsents')}</legend>
          {!documentsAvailable ? <p className="error">{translate(locale, 'legalUnavailable')}</p> : null}
          {documents.map((document) => {
            const required = requiredDocuments.some((item) => item.id === document.id);
            const key = consentKey(document);
            return <div className="consent-item" key={key}><label><input checked={accepted.has(key)} onChange={(event) => setAccepted((current) => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next; })} required={required} type="checkbox" /><span>{document.title} <small>{document.locale} · v{document.version}{required ? ` · ${translate(locale, 'required')}` : ''}</small></span></label><button className="text-button" onClick={() => setExpandedDocument(expandedDocument === document.id ? undefined : document.id)} type="button">{translate(locale, 'readDocument')}</button>{expandedDocument === document.id ? <div className="consent-document"><SafeMarkdown markdown={document.bodyMarkdown} /></div> : null}</div>;
          })}
        </fieldset>
        {error ? <p className="error" role="alert">{translate(locale, 'registrationFailed')}</p> : null}
        <button disabled={busy === 'register' || !verificationToken || !allRequiredAccepted || password !== confirmPassword} type="submit">{busy === 'register' ? translate(locale, 'loading') : translate(locale, 'register')}</button>
      </form>
    </main>
  );
}

function consentKey(document: LegalDocument): string {
  return `${document.id}:${document.version}`;
}
