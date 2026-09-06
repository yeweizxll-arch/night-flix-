import { Alert, Button, Form, InputNumber, message, Modal, Typography } from 'antd';
import { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

interface Ranking { weight: number; pinnedRank: number; version: number }

export function DramaRankingButton({ dramaId }: { dramaId: string }) {
  const { request } = useAuth();
  const [form] = Form.useForm<Ranking>();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<number>();
  const [error, setError] = useState<string>();
  const [messages, holder] = message.useMessage();
  const revision = useRef(0);
  const path = `/api/v1/tenant/content/dramas/${dramaId}/discovery`;

  async function load() {
    const current = ++revision.current;
    setOpen(true); setBusy(true); setVersion(undefined); setError(undefined);
    try {
      const settings = await request<Ranking>(path);
      if (current !== revision.current) return;
      form.setFieldsValue(settings); setVersion(settings.version);
    } catch (cause) {
      if (current === revision.current) setError(cause instanceof Error ? cause.message : '加载失败');
    } finally { if (current === revision.current) setBusy(false); }
  }

  async function save() {
    if (version === undefined || busy) return;
    let values: Ranking;
    try { values = await form.validateFields(); } catch { return; }
    setBusy(true); setError(undefined);
    try {
      await request<Ranking>(path, { method: 'PUT', body: JSON.stringify({
        weight: values.weight, pinnedRank: values.pinnedRank, expectedVersion: version,
      }) });
      setOpen(false); messages.success('权重排行已保存，App 刷新后生效');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重新加载后重试');
    } finally { setBusy(false); }
  }

  return <>{holder}<Button size="small" onClick={() => void load()}>权重排行</Button>
    <Modal title="App 推荐与排行" open={open} confirmLoading={busy}
      okText="保存" okButtonProps={{ disabled: version === undefined || busy }}
      onOk={() => void save()} onCancel={() => { if (!busy) { revision.current++; setOpen(false); } }}>
      <Alert showIcon type="info" message="仅影响本代理商 App；不会修改真实热度。新剧榜仍按发布时间排序。" />
      {error ? <Alert type="error" message={error} action={<Button onClick={() => void load()}>重新加载</Button>} /> : null}
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="推荐权重" name="weight" rules={[{ required: true, type: 'integer', min: -100000, max: 100000 }]}
          extra="默认 0；正数提升、负数降低。在真实热度和观看偏好得分上加权。">
          <InputNumber min={-100000} max={100000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="置顶顺序" name="pinnedRank" rules={[{ required: true, type: 'integer', min: 0, max: 1000 }]}
          extra="0 不置顶；1 最靠前，2 次之。同序号再按综合得分排序。">
          <InputNumber min={0} max={1000} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary">顺序：置顶 → 真实热度 + 权重（首页另加观看偏好）→ 发布时间。下架和地域限制始终优先。</Typography.Text>
    </Modal></>;
}
