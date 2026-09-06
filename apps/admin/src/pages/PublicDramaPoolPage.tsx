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

interface PoolDrama {
  code: string;
  dramaId: string;
  publicationStatus: 'approved' | 'pending_review' | 'published' | 'rejected' | 'unpublished';
  publicationVersion: number;
  summary: string;
  title: string;
  totalEpisodes: number;
}

interface PoolResponse { items: PoolDrama[]; page: number; pageSize: number; total: number }

interface PublishValues {
  allowedCountries?: string;
  blockedCountries?: string;
  dramaPoints?: number;
}

interface RuntimeConfig {
  admob: Record<string, unknown>;
  allowedCountries: string[];
  deepLinkHost?: string;
  featureFlags: Record<string, unknown>;
  storeProducts: Record<string, unknown>;
  supportedLocales: string[];
  version: number;
}

interface RuntimeValues {
  admob: string;
  allowedCountries?: string;
  deepLinkHost?: string;
  featureFlags: string;
  storeProducts: string;
  supportedLocales: string;
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
  const [publishForm] = Form.useForm<PublishValues>();
  const [runtimeForm] = Form.useForm<RuntimeValues>();
  const canReview = principal?.permissions.includes('content.drama.submit_review');
  const canPublish = principal?.permissions.includes('content.drama.update');
  const canManageSite = principal?.permissions.includes('tenant.site.manage');

  const loadPool = useCallback(async (page = 1, pageSize = 20) => {
    setLoading(true); setError(undefined);
    try {
      setPool(await request<PoolResponse>(
        `/api/v1/tenant/public-drama-pool?page=${page}&pageSize=${pageSize}`,
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公共剧池加载失败');
    } finally { setLoading(false); }
  }, [request]);

  const loadRuntime = useCallback(async () => {
    try {
      const value = await request<RuntimeConfig>('/api/v1/tenant/app-runtime-config');
      setRuntime(value);
      runtimeForm.setFieldsValue({
        admob: JSON.stringify(value.admob, null, 2),
        allowedCountries: value.allowedCountries.join(','),
        deepLinkHost: value.deepLinkHost,
        featureFlags: JSON.stringify(value.featureFlags, null, 2),
        storeProducts: JSON.stringify(value.storeProducts, null, 2),
        supportedLocales: value.supportedLocales.join(','),
      });
    } catch (cause) {
      messageApi.error(cause instanceof Error ? cause.message : 'App 配置加载失败');
    }
  }, [messageApi, request, runtimeForm]);

  useEffect(() => { void loadPool(); void loadRuntime(); }, [loadPool, loadRuntime]);

  async function review(record: PoolDrama, decision: 'approved' | 'rejected') {
    let note: string | undefined;
    if (decision === 'rejected') {
      note = window.prompt('请输入拒绝原因')?.trim();
      if (!note) return;
    }
    setSubmitting(true);
    try {
      await request(`/api/v1/tenant/public-drama-pool/${record.dramaId}/review`, {
        body: JSON.stringify({ decision, expectedVersion: record.publicationVersion, note }),
        method: 'POST',
      });
      messageApi.success(decision === 'approved' ? '审核通过' : '已拒绝');
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
        body: JSON.stringify({
          admob: jsonObject(values.admob, 'AdMob 配置'),
          allowedCountries: codes(values.allowedCountries),
          deepLinkHost: values.deepLinkHost?.trim() || null,
          expectedVersion: runtime.version,
          featureFlags: jsonObject(values.featureFlags, '功能开关'),
          storeProducts: jsonObject(values.storeProducts, '商店商品映射'),
          supportedLocales: codes(values.supportedLocales, false),
        }),
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
      总部发布的完结剧在这里统一可见；当前代理商独立审核、定价和上架，不影响其他代理商。
    </Typography.Paragraph>
    <Tabs items={[
      { key: 'pool', label: '中央公共剧池', children: <Card>
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
              {canPublish ? <DramaRankingButton dramaId={record.dramaId} /> : null}
              {canReview && ['pending_review', 'rejected', 'unpublished'].includes(record.publicationStatus)
                ? <><Button size="small" type="primary" loading={submitting} onClick={() => void review(record, 'approved')}>审核通过</Button>
                  <Button size="small" danger loading={submitting} onClick={() => void review(record, 'rejected')}>拒绝</Button></> : null}
              {canPublish && ['approved', 'unpublished'].includes(record.publicationStatus)
                ? <Button size="small" onClick={() => setPublishing(record)}>配置并上架</Button> : null}
              {canPublish && record.publicationStatus === 'published'
                ? <Popconfirm title="确认下架？已购用户仍可观看。" onConfirm={() => void unpublish(record)}>
                  <Button size="small" danger>下架</Button></Popconfirm> : null}
            </Space> },
          ]}
        />
      </Card> },
      { key: 'runtime', label: 'App 运行配置', children: <Card>
        <Alert showIcon type="info" message="这里只热更新文案、语言、主题、广告位和运营开关；App ID、签名及商店账号仍按代理商独立构建。" />
        <Form form={runtimeForm} layout="vertical" onFinish={(values) => void saveRuntime(values)} style={{ marginTop: 20 }}>
          <Form.Item name="supportedLocales" label="支持语言" rules={[{ required: true }]}><Input placeholder="en-US,es-ES,pt-BR" /></Form.Item>
          <Form.Item name="allowedCountries" label="发行国家"><Input placeholder="US,SG,MY" /></Form.Item>
          <Form.Item name="deepLinkHost" label="Deep Link 域名"><Input placeholder="drama.agent.example" /></Form.Item>
          <Form.Item name="featureFlags" label="功能开关 JSON" rules={[{ required: true }]}><Input.TextArea autoSize={{ minRows: 4 }} /></Form.Item>
          <Form.Item name="admob" label="AdMob 广告位 JSON" rules={[{ required: true }]}><Input.TextArea autoSize={{ minRows: 5 }} /></Form.Item>
          <Form.Item name="storeProducts" label="Apple / Google 商品映射 JSON" rules={[{ required: true }]}><Input.TextArea autoSize={{ minRows: 5 }} /></Form.Item>
          <Button htmlType="submit" type="primary" disabled={!canManageSite} loading={submitting}>保存运行配置</Button>
        </Form>
      </Card> },
    ]} />
    <Modal title={publishing ? `上架：${publishing.title}` : '上架'} open={Boolean(publishing)}
      okText="确认上架" confirmLoading={submitting} onCancel={() => setPublishing(undefined)}
      onOk={() => void publishForm.validateFields().then((values) => publish(values))}>
      <Form form={publishForm} layout="vertical">
        <Form.Item name="dramaPoints" label="整剧金币价格"><InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="留空表示不设置整剧金币价" /></Form.Item>
        <Form.Item name="allowedCountries" label="允许国家"><Input placeholder="US,SG；留空表示不限制" /></Form.Item>
        <Form.Item name="blockedCountries" label="屏蔽国家"><Input placeholder="CN,KP" /></Form.Item>
      </Form>
    </Modal>
  </>;
}

function codes(value?: string, uppercase = true): string[] {
  return [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    .map((item) => uppercase ? item.toUpperCase() : item))];
}

function jsonObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function statusName(status: PoolDrama['publicationStatus']) {
  return ({ approved: '已审核', pending_review: '待审核', published: '已上架', rejected: '已拒绝', unpublished: '已下架' } as const)[status];
}

function statusColor(status: PoolDrama['publicationStatus']) {
  return ({ approved: 'blue', pending_review: 'default', published: 'green', rejected: 'red', unpublished: 'orange' } as const)[status];
}
