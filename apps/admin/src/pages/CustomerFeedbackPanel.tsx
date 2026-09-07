import { Alert, Button, Input, message, Modal, Table, Tag } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

interface Feedback { id: string; body: string; reply?: string; createdAt: string; repliedAt?: string }
export function CustomerFeedbackPanel({ canManage }: { canManage: boolean }) {
  const { request } = useAuth();
  const [items, setItems] = useState<Feedback[]>([]);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [target, setTarget] = useState<Feedback>();
  const [reply, setReply] = useState('');
  const [messages, holder] = message.useMessage();
  const load = useCallback(async () => {
    setBusy(true); setError(undefined);
    try { setItems((await request<{ items: Feedback[] }>(`/api/v1/tenant/interactions/feedback?page=${page}`)).items); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载失败'); }
    finally { setBusy(false); }
  }, [page, request]);
  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (!target || !reply.trim() || busy) return;
    setBusy(true);
    try {
      await request(`/api/v1/tenant/interactions/feedback/${target.id}/reply`, { method: 'POST', body: JSON.stringify({ reply: reply.trim() }) });
      setTarget(undefined); messages.success('已回复，用户会在 App 消息中收到通知'); await load();
    } catch (cause) { messages.error(cause instanceof Error ? cause.message : '回复失败'); }
    finally { setBusy(false); }
  }

  return <>{holder}<Button onClick={() => void load()} loading={busy}>刷新反馈</Button>
    {error ? <Alert type="error" message={error} /> : null}
    <Table rowKey="id" dataSource={items} loading={busy} pagination={{ current: page, pageSize: 30, showSizeChanger: false,
      total: (page - 1) * 30 + items.length + (items.length === 30 ? 1 : 0), onChange: setPage }} columns={[
      { title: '反馈内容', dataIndex: 'body', render: value => <span style={{ whiteSpace: 'pre-wrap' }}>{value}</span> },
      { title: '时间', dataIndex: 'createdAt', render: (value: string) => new Date(value).toLocaleString() },
      { title: '回复', render: (_, item) => item.reply ? <span style={{ whiteSpace: 'pre-wrap' }}>{item.reply}</span> : <Tag>待回复</Tag> },
      { title: '操作', render: (_, item) => canManage && !item.reply ? <Button onClick={() => { setTarget(item); setReply(''); }}>回复</Button> : null },
    ]} />
    <Modal title="回复用户反馈" open={!!target} onCancel={() => { if (!busy) setTarget(undefined); }} onOk={() => void submit()}
      confirmLoading={busy} okButtonProps={{ disabled: !reply.trim() }}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{target?.body}</p>
      <Input.TextArea aria-label="回复内容" placeholder="请输入回复内容" rows={5} maxLength={2000} showCount value={reply} onChange={event => setReply(event.target.value)} />
    </Modal></>;
}
