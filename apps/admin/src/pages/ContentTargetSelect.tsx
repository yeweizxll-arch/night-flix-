import { Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

export function ContentTargetSelect({ value, onChange, type = 'drama', disabled, id }: {
  value?: string; onChange?(value?: string): void; type?: 'drama' | 'episode'; disabled?: boolean; id?: string;
}) {
  const { request } = useAuth();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    const timer = setTimeout(() => {
      setLoading(true); setError(undefined);
      const params = new URLSearchParams({ type, q: query, ...(value ? { selected: value } : {}) });
      void request<{ items: { value: string; label: string }[] }>(`/api/v1/tenant/commerce/catalog/content-options?${params}`)
        .then(result => { if (sequence.current === current) setOptions(result.items); })
        .catch(cause => { if (sequence.current === current) { setOptions([]); setError(cause instanceof Error ? cause.message : '加载失败，请重新搜索'); } })
        .finally(() => { if (sequence.current === current) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [type, query, value, request]);
  return <Select id={id} showSearch allowClear disabled={disabled} filterOption={false} value={value}
    options={options} loading={loading} onSearch={setQuery} onChange={onChange} style={{ width: '100%' }}
    placeholder="搜索已上架剧名或编号" notFoundContent={error ?? (loading ? '加载中…' : '没有匹配内容，请检查是否已上架或更换搜索词')} />;
}
