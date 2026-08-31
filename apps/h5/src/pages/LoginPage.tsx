import { useState, type FormEvent } from 'react';

import type { ContentLocale } from '../api/types';
import { translate } from '../i18n';
import { navigate, parseHashRoute } from '../router';
import { useSession } from '../session';

export function LoginPage({ locale, returnTo }: { locale: ContentLocale; returnTo?: string }) {
  const { login, principal } = useSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (principal) return <main className="page narrow"><p>{principal.username}</p><button onClick={() => navigate(returnTo ? parseHashRoute(returnTo) : { name: 'home' })}>{translate(locale, 'back')}</button></main>;
  const submit = (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setFailed(false);
    void login(identifier.trim(), password).then(() => navigate(returnTo ? parseHashRoute(returnTo) : { name: 'home' })).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return <main className="page narrow auth-card"><h1>{translate(locale, 'login')}</h1><p>{translate(locale, 'loginHint')}</p>
    <form onSubmit={submit}>
      <label>{translate(locale, 'username')}<input autoComplete="username" required maxLength={254} value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></label>
      <label>{translate(locale, 'password')}<input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {failed && <p className="error" role="alert">{translate(locale, 'error')}</p>}
      <button type="submit" disabled={busy}>{busy ? translate(locale, 'loading') : translate(locale, 'login')}</button>
    </form>
    <p className="notice">{translate(locale, 'noRemember')}</p>
    <div className="auth-links"><button className="text-button" onClick={() => navigate({ name: 'register' })} type="button">{translate(locale, 'register')}</button><button className="text-button" onClick={() => navigate({ name: 'legal' })} type="button">{translate(locale, 'legalDocuments')}</button></div>
  </main>;
}
