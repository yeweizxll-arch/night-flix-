import { Input, Select } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

// Search stays paged on the server: no all-tenant download just to populate a form.
export function MerchantSelect({ value, onChange, disabled, placeholder = '搜索代理商名称或编号', id }: {
  value?: string; onChange?(value: string): void; disabled?: boolean; placeholder?: string; id?: string;
}) {
  const { principal, request } = useAuth();
  const allowed = principal?.permissions.includes('platform.merchant.read');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ label: string; value: string }[]>([]);
  const [selected, setSelected] = useState<{ label: string; value: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  useEffect(() => {
    if (!allowed) return;
    const current = ++sequence.current;
    const timer = setTimeout(() => {
      setLoading(true); setError(undefined);
      void request<{ items: { id: string; name: string; code: string }[] }>(`/api/v1/platform/merchants?page=1&pageSize=30&q=${encodeURIComponent(query)}`)
        .then(result => { if (current === sequence.current) setOptions(result.items.map(row => ({ label: `${row.name}（${row.code}）`, value: row.id }))); })
        .catch(reason => { if (current === sequence.current) { setOptions([]); setError(reason instanceof Error ? reason.message : '加载失败，请重新搜索'); } })
        .finally(() => { if (current === sequence.current) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [allowed, query, request]);
  if (!allowed) return <Input id={id} value={value} onChange={event => onChange?.(event.target.value)} disabled={disabled}
    placeholder="代理商编号（需代理商查看权限才可搜索）" maxLength={36} />;
  const visible = selected && selected.value === value && !options.some(option => option.value === value) ? [selected, ...options] : options;
  return <Select id={id} aria-label="选择代理商" showSearch allowClear disabled={disabled} style={{ width: '100%', minWidth: 230 }}
    loading={loading} filterOption={false} options={visible} value={value || undefined} onSearch={setQuery}
    onChange={(next, option) => { if (option && !Array.isArray(option)) setSelected(option); onChange?.(next ?? ''); }}
    placeholder={placeholder} notFoundContent={error ?? (loading ? '搜索中…' : '没有匹配的代理商，请修改搜索词')} />;
}
