import { useEffect, useState } from 'react';

import type { ContentLocale, CurrentLegalDocumentsResponse, LegalDocument } from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { SafeMarkdown } from '../safe-markdown';
import { useSession } from '../session';
import { Empty, ErrorState, Loading } from '../ui';

export function LegalDocumentsPage({ locale }: { locale: ContentLocale }) {
  const { api } = useSession();
  const [documents, setDocuments] = useState<LegalDocument[]>([]);
  const [selected, setSelected] = useState<string>();
  const [status, setStatus] = useState<'error' | 'loading' | 'ready'>('loading');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setStatus('loading');
    void api.request<CurrentLegalDocumentsResponse>(
      `/api/v1/customer/legal/documents/current?locale=${encodeURIComponent(locale)}`,
      { cache: 'no-store', requiresAuth: false },
    ).then((response) => {
      if (!active) return;
      setDocuments(response.documents);
      setSelected((current) => response.documents.some((item) => item.id === current)
        ? current
        : response.documents[0]?.id);
      setStatus('ready');
    }).catch(() => { if (active) setStatus('error'); });
    return () => { active = false; };
  }, [api, locale, reload]);
  if (status === 'loading') return <Loading locale={locale} />;
  if (status === 'error') return <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} />;
  const document = documents.find((item) => item.id === selected);
  return (
    <main className="page legal-page">
      <button className="text-button" onClick={() => navigate({ name: 'home' })}>← {translate(locale, 'back')}</button>
      <h1>{translate(locale, 'legalDocuments')}</h1>
      {documents.length === 0 ? <Empty locale={locale} /> : (
        <>
          <div className="chips legal-tabs">
            {documents.map((item) => (
              <button className={item.id === selected ? 'active' : ''} key={item.id} onClick={() => setSelected(item.id)} type="button">
                {item.title}
              </button>
            ))}
          </div>
          {document ? (
            <article className="panel legal-document">
              <h1>{document.title}</h1>
              <small>{document.locale} · v{document.version}{document.effectiveAt ? ` · ${new Date(document.effectiveAt).toLocaleDateString(locale)}` : ''}</small>
              <SafeMarkdown markdown={document.bodyMarkdown} />
            </article>
          ) : null}
        </>
      )}
    </main>
  );
}
