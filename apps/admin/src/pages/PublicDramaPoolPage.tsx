import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { DramaRankingButton } from './DramaRankingButton';
import { RuntimeConfigForm } from './RuntimeConfigForm';
import { runtimeToForm, runtimePayload, type RuntimeConfig, type RuntimeValues } from './runtime-config-ui';

interface PoolDrama {
  code: string;
  dramaId: string;
  publicationStatus: 'approved' | 'pending_review' | 'published' | 'rejected' | 'unpublished';
  publicationVersion: number;
  summary: string;
  title: string;
  totalEpisodes: number;
  allowedCountries?: string[];
  blockedCountries?: string[];
  dramaPoints?: number;
}

interface PoolResponse { items: PoolDrama[]; page: number; pageSize: number; total: number }

interface PublishValues {
  allowedCountries?: string;
  blockedCountries?: string;
  dramaPoints?: number;
}

const emptyPool: PoolResponse = { items: [], page: 1, pageSize: 20, total: 0 };

export function PublicDramaPoolPage() {
  const { principal, request } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();
  const [pool, setPool] = useState(emptyPool);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [publishing, setPublishing] = useState<PoolDrama>();
  const [submitting, setSubmitting] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeConfig>();
  const [runtimeError, setRuntimeError] = useState<string>();
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [rejecting, setRejecting] = useState<PoolDrama>();
  const [rejectForm] = Form.useForm<{ note: string }>();
  const [publishForm] = Form.useForm<PublishValues>();
  const [runtimeForm] = Form.useForm<RuntimeValues>();
  const canReview = principal?.permissions.includes('content.drama.submit_review');
  const canPublish = principal?.permissions.includes('content.drama.update');
  const canManageSite = principal?.permissions.includes('tenant.site.manage');
  const canReadSite = principal?.permissions.includes('tenant.site.read');
  const canReadContent = principal?.permissions.includes('content.drama.read');

  const loadPool = useCallback(async (page = 1, pageSize = 20) => {
    if (!canReadContent) return;
    setLoading(true); setError(undefined);
    try {
      setPool(await request<PoolResponse>(
        `/api/v1/tenant/public-drama-pool?page=${page}&pageSize=${pageSize}`,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公共剧池加载失败');
    } finally { setLoading(false); }
  }, [request, canReadContent]);

  const loadRuntime = useCallback(async () => {
    if (!canReadSite) return;
    setRuntimeLoading(true); setRuntimeError(undefined);
    try {
      const value = await request<RuntimeConfig>('/api/v1/tenant/app-runtime-config');
      setRuntime(value);
      runtimeForm.setFieldsValue(runtimeToForm(value));
    } catch (cause) {
      setRuntimeError(cause instanceof Error ? cause.message : 'App 配置加载失败');
    } finally {
      setRuntimeLoading(false);
    }
  }, [canReadSite, request, runtimeForm]);

  useEffect(() => { void loadPool(); void loadRuntime(); }, [loadPool, loadRuntime]);

  async function review(record: PoolDrama, decision: 'approved' | 'rejected', note?: string) {
    setSubmitting(true);
    try {
      await request(`/api/v1/tenant/public-drama-pool/${record.dramaId}/review`, {
        body: JSON.stringify({ decision, expectedVersion: record.publicationVersion, note }),
        method: 'POST',
      });
      messageApi.success(decision === 'approved' ? '审核通过' : '已拒绝');
      setRejecting(undefined);
      await loadPool(pool.page, pool.pageSize);
    } catch (cause) {
      messageApi.error(cause instanceof Error ? cause.message : '审核失败');
    } finally { setSubmitting(false); }
  }

  async function publish(values: PublishValues) {
    if (!publishing) return;
    setSubmitting(true);
    try {
      await request(`/api/v1/tenant/public-drama-pool/${publishing.dramaId}/publish`, {
        body: JSON.stringify({
          allowedCountries: codes(values.allowedCountries),
          blockedCountries: codes(values.blockedCountries),
          dramaPoints: values.dramaPoints,
          expectedVersion: publishing.publicationVersion,
        }),
        method: 'POST',
      });
      setPublishing(undefined); publishForm.resetFields();
      messageApi.success('已上架到当前代理商 App');
      await loadPool(pool.page, pool.pageSize);
    } catch (cause) {
      messageApi.error(cause instanceof Error ? cause.message : '上架失败');
    } finally { setSubmitting(false); }
  }

  async function unpublish(record: PoolDrama) {
    setSubmitting(true);
    try {
      await request(`/api/v1/tenant/public-drama-pool/${record.dramaId}/unpublish`, {
        body: JSON.stringify({ expectedVersion: record.publicationVersion }), method: 'POST',
      });
      messageApi.success('已下架；用户永久购买权益仍保留');
      await loadPool(pool.page, pool.pageSize);
    } catch (cause) {
      messageApi.error(cause instanceof Error ? cause.message : '下架失败');
    } finally { setSubmitting(false); }
  }

  async function saveRuntime(values: RuntimeValues) {
    if (!runtime) return;
    setSubmitting(true);
    try {
      await request('/api/v1/tenant/app-runtime-config', {
        body: JSON.stringify(runtimePayload(values, runtime)),
        method: 'PUT',
      });
      messageApi.success('App 运行配置已保存');
      await loadRuntime();
    } catch (cause) {
      messageApi.error(cause instanceof Error ? cause.message : '保存失败');
    } finally { setSubmitting(false); }
  }

  return <>
    {contextHolder}
    <Typography.Title level={2}>公共剧池与 App 配置</Typography.Title>
    <Typography.Paragraph type="secondary">
      挑选公共剧目，审核后上架到你的 App。
    </Typography.Paragraph>
    <Tabs items={[
      ...(canReadContent ? [{ key: 'pool', label: '中央公共剧池', children: <Card>
        {error ? <Alert message={error} type="error" showIcon action={<Button onClick={() => void loadPool()}>重试</Button>} /> : null}
        <Table<PoolDrama>
          dataSource={pool.items} loading={loading} rowKey="dramaId"
          pagination={{ current: pool.page, pageSize: pool.pageSize, total: pool.total,
            onChange: (page, pageSize) => void loadPool(page, pageSize) }}
          columns={[
            { title: '剧目', render: (_, record) => <Space direction="vertical" size={0}>
              <Typography.Text strong>{record.title}</Typography.Text>
              <Typography.Text type="secondary">{record.code} · {record.totalEpisodes} 集</Typography.Text>
            </Space> },
            { title: '简介', dataIndex: 'summary', ellipsis: true },
            { title: '当前状态', render: (_, record) => <Tag color={statusColor(record.publicationStatus)}>{statusName(record.publicationStatus)}</Tag> },
            { title: '操作', width: 260, render: (_, record) => <Space wrap>
              {canPublish && ['published', 'unpublished'].includes(record.publicationStatus) ? <DramaRankingButton dramaId={record.dramaId} /> : null}
              {canReview && ['pending_review', 'rejected', 'unpublished'].includes(record.publicationStatus)
                ? <><Button size="small" type="primary" loading={submitting} onClick={() => void review(record, 'approved')}>审核通过</Button>
                  <Button size="small" danger loading={submitting} onClick={() => { rejectForm.resetFields(); setRejecting(record); }}>拒绝</Button></> : null}
              {canPublish && ['approved', 'unpublished'].includes(record.publicationStatus)
                ? <Button size="small" onClick={() => {
                  publishForm.resetFields();
                  publishForm.setFieldsValue({ dramaPoints: record.dramaPoints,
                    allowedCountries: record.allowedCountries?.join(','), blockedCountries: record.blockedCountries?.join(',') });
                  setPublishing(record);
                }}>配置并上架</Button> : null}
              {canPublish && record.publicationStatus === 'published'
                ? <Popconfirm title="确认下架？已购用户仍可观看。" onConfirm={() => void unpublish(record)}>
                  <Button size="small" danger>下架</Button></Popconfirm> : null}
            </Space> },
          ]}
        />
      </Card> }] : []),
      ...(canReadSite ? [{ key: 'runtime', label: 'App 运行配置', children: <Card loading={runtimeLoading}>
        {runtimeError ? <Alert type="error" showIcon message={runtimeError} action={<Button onClick={() => void loadRuntime()}>重试</Button>} /> : null}
        <RuntimeConfigForm form={runtimeForm} disabled={!canManageSite || !runtime || Boolean(runtimeError)} loading={submitting} onSave={(values) => void saveRuntime(values)} />
      </Card> }] : []),
    ]} />
    <Modal title={publishing ? `上架：${publishing.title}` : '上架'} open={Boolean(publishing)}
      okText="确认上架" confirmLoading={submitting} onCancel={() => setPublishing(undefined)}
      onOk={() => publishForm.submit()}>
      <Form name="publicdramapoolpage-1" form={publishForm} layout="vertical" onFinish={(values) => void publish(values)}>
        <Form.Item name="dramaPoints" label="整剧金币价格" extra="留空保留原有价格；调整或停用价格也可前往商品定价。"><InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="未设置整剧金币价" /></Form.Item>
        <Form.Item name="allowedCountries" label="允许国家"><Input placeholder="US,SG；留空表示不限制" /></Form.Item>
        <Form.Item name="blockedCountries" label="屏蔽国家"><Input placeholder="CN,KP" /></Form.Item>
      </Form>
    </Modal>
    <Modal title={rejecting ? `拒绝：${rejecting.title}` : '拒绝剧目'} open={Boolean(rejecting)}
      okText="确认拒绝" confirmLoading={submitting} onCancel={() => setRejecting(undefined)} onOk={() => rejectForm.submit()}>
      <Form name="publicdramapoolpage-2" form={rejectForm} layout="vertical" onFinish={values => { if (rejecting) void review(rejecting, 'rejected', values.note.trim()); }}>
        <Form.Item name="note" label="拒绝原因" rules={[{ required: true, whitespace: true, message: '请填写拒绝原因' }]}><Input.TextArea maxLength={2000} showCount rows={3} /></Form.Item>
      </Form>
    </Modal>
  </>;
}

function codes(value?: string, uppercase = true): string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => uppercase ? item.toUpperCase() : item))];
}

function statusName(status: PoolDrama['publicationStatus']) {
  return ({ approved: '已审核', pending_review: '待审核', published: '已上架', rejected: '已拒绝', unpublished: '已下架' } as const)[status];
}

function statusColor(status: PoolDrama['publicationStatus']) {
  return ({ approved: 'blue', pending_review: 'default', published: 'green', rejected: 'red', unpublished: 'orange' } as const)[status];
}
