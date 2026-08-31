import { useEffect, useRef, useState } from 'react';

import type { ContentLocale, DramaListItem, PageResponse, TaxonomyResponse } from '../api/types';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';
import { AssetImage, Empty, ErrorState, Loading } from '../ui';

interface Props { locale: ContentLocale }

export function HomePage({ locale }: Props) {
  const { api } = useSession();
  const [items, setItems] = useState<DramaListItem[]>([]);
  const [categories, setCategories] = useState<TaxonomyResponse['items']>([]);
  const [tags, setTags] = useState<TaxonomyResponse['items']>([]);
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.request<TaxonomyResponse>(`/api/v1/customer/content/categories?locale=${encodeURIComponent(locale)}`, { requiresAuth: false }),
      api.request<TaxonomyResponse>(`/api/v1/customer/content/tags?locale=${encodeURIComponent(locale)}`, { requiresAuth: false }),
    ]).then(([nextCategories, nextTags]) => {
      if (!active) return;
      setCategories(nextCategories.items);
      setTags(nextTags.items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [api, locale]);

  useEffect(() => {
    const current = ++sequence.current;
    const params = new URLSearchParams({ locale, page: String(page), pageSize: '12' });
    if (query) params.set('q', query);
    if (category) params.set('category', category);
    if (tag) params.set('tag', tag);
    setLoading(true); setFailed(false);
    void api.request<PageResponse<DramaListItem>>(`/api/v1/customer/content/dramas?${params}`, { requiresAuth: false })
      .then((response) => {
        if (current !== sequence.current) return;
        setItems(response.items); setTotal(response.total);
      })
      .catch(() => { if (current === sequence.current) setFailed(true); })
      .finally(() => { if (current === sequence.current) setLoading(false); });
  }, [api, category, locale, page, query, reload, tag]);

  const resetPage = (setter: () => void) => { setPage(1); setter(); };
  return <main className="page home-page">
    <section className="hero">
      <p className="eyebrow">{translate(locale, 'latest')}</p>
      <h1>{translate(locale, 'latest')}</h1>
      <form className="search" onSubmit={(event) => { event.preventDefault(); resetPage(() => setQuery(draft.trim().slice(0, 100))); }}>
        <input value={draft} maxLength={100} onChange={(event) => setDraft(event.target.value)} placeholder={translate(locale, 'search')} aria-label={translate(locale, 'search')} />
        <button type="submit">{translate(locale, 'searchButton')}</button>
      </form>
    </section>
    <FilterRow label={translate(locale, 'categories')} values={categories} selected={category} locale={locale} onSelect={(value) => resetPage(() => setCategory(value))} />
    <FilterRow label={translate(locale, 'tags')} values={tags} selected={tag} locale={locale} onSelect={(value) => resetPage(() => setTag(value))} />
    {loading ? <Loading locale={locale} /> : failed ? <ErrorState locale={locale} retry={() => setReload((value) => value + 1)} /> : items.length === 0 ? <Empty locale={locale} /> : <>
      <section className="drama-grid">
        {items.map((drama) => <button type="button" className="drama-card" key={drama.id} onClick={() => navigate({ name: 'drama', dramaId: drama.id })}>
          <AssetImage api={api} mediaId={drama.coverMediaId} alt="" className="cover" />
          <span className="card-body"><strong>{drama.title}</strong><small>{drama.totalEpisodes} {translate(locale, 'episodes')}</small><span>{drama.summary}</span></span>
        </button>)}
      </section>
      <nav className="pagination" aria-label="Pagination">
        <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>{translate(locale, 'previous')}</button>
        <span>{page} / {Math.max(1, Math.ceil(total / 12))}</span>
        <button disabled={page * 12 >= total} onClick={() => setPage((value) => value + 1)}>{translate(locale, 'next')}</button>
      </nav>
    </>}
  </main>;
}

function FilterRow({ label, values, selected, onSelect, locale }: { label: string; values: TaxonomyResponse['items']; selected: string; onSelect: (value: string) => void; locale: ContentLocale }) {
  if (values.length === 0) return null;
  return <section className="filter-row"><strong>{label}</strong><div className="chips">
    <button type="button" className={selected === '' ? 'active' : ''} onClick={() => onSelect('')}>{translate(locale, 'all')}</button>
    {values.map((value) => <button type="button" className={selected === value.id ? 'active' : ''} key={value.id} onClick={() => onSelect(value.id)}>{value.name}</button>)}
  </div></section>;
}
