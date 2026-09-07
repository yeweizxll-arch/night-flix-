import { Alert, Button, Input, InputNumber, Modal, Progress, Select, Space, Table, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { prepareEpisodeFiles, runEpisodeBatch, type BatchEpisode } from './batch-episodes';
import { formatContentBytes, validateContentUploadFile } from './content-upload-ui';
import { contentLocaleOptions } from './platform-content-library-ui';
import { readVideoDuration } from './video-duration';

export function BatchEpisodeUploadModal({ scope, dramaId, onClose }: {
  scope: 'platform' | 'tenant'; dramaId: string; onClose(): void;
}) {
  const { request } = useAuth();
  const apiBase = scope === 'platform' ? '/api/v1/platform/content-management' : '/api/v1/tenant/content';
  const rowsRef = useRef<BatchEpisode[]>([]);
  const [rows, setRows] = useState<BatchEpisode[]>([]);
  const [providers, setProviders] = useState<{ id: string; label: string }[]>([]);
  const [providerId, setProviderId] = useState('');
  const [locale, setLocale] = useState('zh-CN');
  const [start, setStart] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const changed = () => setRows([...rowsRef.current]);
  const locked = rows.some(row => row.mediaId || row.saveRequest || row.done);

  useEffect(() => {
    let active = true;
    void request<{ items: { id: string; label: string; status: string; ownerType: string }[] }>(
      `/api/v1/${scope}/storage/providers?pageSize=100`,
    ).then(result => {
      if (!active) return;
      const available = result.items.filter(provider => provider.status === 'active'
        && (scope === 'tenant' || provider.ownerType === 'platform'));
      setProviders(available); setProviderId(available[0]?.id ?? '');
    }).catch(() => { if (active) setError('存储配置加载失败，请关闭后重新打开，或联系管理员'); });
    return () => { active = false; controllerRef.current?.abort(); };
  }, [request, scope]);

  async function selectFiles(files: File[]) {
    if (!files.length || busy) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy(true); setError(undefined);
    try {
      const current = await request<{ episodes: { episodeNo: number }[] }>(`${apiBase}/dramas/${dramaId}`, { signal: controller.signal });
      const next = Math.max(0, ...current.episodes.map(episode => episode.episodeNo)) + 1;
      rowsRef.current = prepareEpisodeFiles(files, next); setStart(next); changed();
      for (const row of rowsRef.current) {
        if (controller.signal.aborted) break;
        row.stage = '读取时长'; changed();
        try {
          const invalid = validateContentUploadFile(row.file, 'video');
          if (invalid) throw new Error(invalid);
          row.durationSeconds = await readVideoDuration(row.file, controller.signal);
          row.stage = '待上传';
        } catch (reason) { row.stage = '待处理'; row.error = reason instanceof Error ? reason.message : '读取失败'; }
        changed();
      }
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '文件选择失败'); }
    finally { setBusy(false); controllerRef.current = undefined; }
  }

  async function run() {
    if (busy || !providerId || !rows.length) return;
    const controller = new AbortController(); controllerRef.current = controller;
    setBusy(true); setError(undefined);
    try { await runEpisodeBatch(rowsRef.current, { apiBase, dramaId, locale, providerId, request,
      signal: controller.signal, changed }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '批量添加失败'); }
    finally { setBusy(false); controllerRef.current = undefined; changed(); }
  }

  const completed = rows.filter(row => row.done).length;
  return <Modal open title="批量添加剧集" width={980} footer={null} closable={!busy} maskClosable={false} keyboard={!busy} onCancel={onClose}>
    <Alert showIcon type="info" className="page-alert" message="一次选择多个视频，按文件名自然排序、连续编号；可先调整集数和标题。每集时长自动读取，不需要填写。"
      description="仅添加正片草稿，不自动上架、不生成试看。请保持页面打开；可暂停后继续，成功的剧集不会重复上传。关闭或刷新页面会清除未完成队列，已添加剧集仍保留。" />
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <label>存储 <Select aria-label="批量上传存储" disabled={busy || locked} style={{ width: 300 }} value={providerId || undefined}
          onChange={setProviderId} options={providers.map(provider => ({ value: provider.id, label: provider.label }))} /></label>
        <label>标题语言 <Select aria-label="批量剧集标题语言" disabled={busy || locked} style={{ width: 130 }} value={locale} onChange={setLocale} options={contentLocaleOptions} /></label>
        <label>起始集数 <InputNumber aria-label="起始集数" min={1} max={1000} precision={0} value={start} disabled={busy || locked}
          onChange={value => { if (!value) return; setStart(value); rowsRef.current.forEach((row, index) => { row.episodeNo = value + index; }); changed(); }} /></label>
      </Space>
      {/* Native file input: resetting a selection must not replay AntD's cached fake path. */}
      <input className="ant-input" type="file" multiple aria-label="选择多个剧集视频" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" disabled={busy || (locked && completed !== rows.length)}
        onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void selectFiles(files); }} />
      <Typography.Text type="secondary">MP4 / MOV / WebM，每集最大 2 GiB，单部短剧最多 1000 集。时长自动向上取整到秒。</Typography.Text>
      {error && <Alert showIcon type="error" message={error} />}
      <Table<BatchEpisode> size="small" rowKey="id" dataSource={rows} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 830 }}
        columns={[
          { title: '集数', width: 95, render: (_, row) => <InputNumber aria-label={`${row.file.name} 集数`} value={row.episodeNo} min={1} max={1000} precision={0}
            disabled={busy || row.done || Boolean(row.saveRequest)} onChange={value => { row.episodeNo = value ?? 0; changed(); }} /> },
          { title: '视频文件', width: 220, render: (_, row) => <><div style={{ overflowWrap: 'anywhere' }}>{row.file.name}</div><Typography.Text type="secondary">{formatContentBytes(row.file.size)}</Typography.Text></> },
          { title: '标题', width: 190, render: (_, row) => <Input aria-label={`${row.file.name} 标题`} value={row.title} maxLength={200}
            disabled={busy || row.done || Boolean(row.saveRequest)} onChange={event => { row.title = event.target.value; changed(); }} /> },
          { title: '自动时长', width: 85, render: (_, row) => row.durationSeconds ? `${row.durationSeconds} 秒` : '—' },
          { title: '状态', width: 170, render: (_, row) => <><div>{row.stage ?? '待上传'}</div>{row.error && <Typography.Text type="danger">{row.error}</Typography.Text>}</> },
          { title: '操作', width: 75, render: (_, row) => !row.done && <Button type="link" danger disabled={busy || Boolean(row.saveRequest)}
            onClick={() => { rowsRef.current = rowsRef.current.filter(item => item.id !== row.id); changed(); }}>移除</Button> },
        ]} />
      <Progress percent={rows.length ? Math.floor(completed * 100 / rows.length) : 0} format={() => `${completed} / ${rows.length} 集已添加`} />
      <Space>
        <Button type="primary" disabled={busy || !providerId || !rows.length || completed === rows.length} onClick={() => void run()}>上传并添加 / 重试未完成</Button>
        {busy && <Button onClick={() => controllerRef.current?.abort()}>暂停</Button>}
        <Button disabled={busy} onClick={onClose}>完成并返回</Button>
      </Space>
    </Space>
  </Modal>;
}
