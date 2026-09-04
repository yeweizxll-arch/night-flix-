import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAuth } from '../auth/AuthProvider';

const API_BASE = '/api/v1/platform/content-revenue';
const currencies = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;

interface PolicyRecord {
  contentScope: 'private' | 'public';
  creatorBps: number;
  headquartersBps: number;
  id: string;
  incomeType: 'coin_unlock' | 'content_ad' | 'membership';
  status: 'active' | 'disabled';
  tenantBps: number;
  tenantId: string;
  updatedAt: string;
  version: number;
}

interface LedgerRecord {
  contentScope: 'private' | 'public';
  creatorId?: string;
  creatorMinor: string;
  currency: string;
  dramaId: string;
  episodeId?: string;
  grossMinor: string;
  headquartersMinor: string;
  id: string;
  incomeType: string;
  occurredAt: string;
  settlementMonth: string;
  sourceId: string;
  sourceType: string;
  status: 'pending' | 'reversed' | 'settled';
  tenantId: string;
  tenantMinor: string;
}

interface PolicyFormValue {
  contentScope: PolicyRecord['contentScope'];
  creatorBps: number;
  headquartersBps: number;
  incomeType: PolicyRecord['incomeType'];
  status: PolicyRecord['status'];
  tenantBps: number;
  tenantId: string;
}

export function ContentRevenuePage() {
  const { principal, request } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();
  const [form] = Form.useForm<PolicyFormValue>();
  const [tenantId, setTenantId] = useState('');
  const [month, setMonth] = useState(previousUtcMonth());
  const [currency, setCurrency] = useState<(typeof currencies)[number]>('USD');
  const [policies, setPolicies] = useState<PolicyRecord[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [editing, setEditing] = useState<PolicyRecord | 'create'>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const canManage = principal?.permissions.includes('finance.settlement.manage') ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (tenantId.trim()) query.set('tenantId', tenantId.trim());
      if (month) query.set('month', month);
      const policyQuery = tenantId.trim() ? `?tenantId=${encodeURIComponent(tenantId.trim())}` : '';
      const [policyResult, ledgerResult] = await Promise.all([
        request<{ items: PolicyRecord[] }>(`${API_BASE}/policies${policyQuery}`),
        request<{ items: LedgerRecord[] }>(`${API_BASE}/ledger?${query}`),
      ]);
      setPolicies(policyResult.items);
      setLedger(ledgerResult.items);
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '内容分成数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [messageApi, month, request, tenantId]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => ledger
    .filter((item) => item.currency === currency && item.status !== 'reversed')
    .reduce((sum, item) => ({
      creator: sum.creator + BigInt(item.creatorMinor),
      gross: sum.gross + BigInt(item.grossMinor),
      headquarters: sum.headquarters + BigInt(item.headquartersMinor),
      tenant: sum.tenant + BigInt(item.tenantMinor),
    }), { creator: 0n, gross: 0n, headquarters: 0n, tenant: 0n }), [currency, ledger]);

  function openPolicy(record?: PolicyRecord) {
    form.setFieldsValue(record ?? {
      contentScope: 'public', creatorBps: 2000, headquartersBps: 2000,
      incomeType: 'coin_unlock', status: 'active', tenantBps: 6000,
      tenantId: tenantId.trim(),
    });
    setEditing(record ?? 'create');
  }

  async function savePolicy(values: PolicyFormValue) {
    const total = values.headquartersBps + values.tenantBps + values.creatorBps;
    if (total !== 10_000) {
      messageApi.error('总部、代理商、创作者分成合计必须等于 10000 基点');
      return;
    }
    setSubmitting(true);
    try {
      await request(`${API_BASE}/policies/${encodeURIComponent(values.tenantId.trim())}`, {
        body: JSON.stringify({
          ...values,
          expectedVersion: editing === 'create' ? 0 : editing?.version ?? 0,
          tenantId: undefined,
        }),
        method: 'PUT',
      });
      messageApi.success('分成策略已保存');
      setEditing(undefined);
      await load();
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '分成策略保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function settle() {
    if (!tenantId.trim()) {
      messageApi.warning('按月结算前请输入代理商 Tenant UUID');
      return;
    }
    setSubmitting(true);
    try {
      const result = await request<{ alreadySettled: boolean; count: number }>(
        `${API_BASE}/settlements/${encodeURIComponent(tenantId.trim())}/${month}/${currency}`,
        { body: '{}', method: 'PUT' },
      );
      messageApi.success(result.alreadySettled
        ? `该月份已经结算，共 ${result.count} 笔`
        : `已结算 ${result.count} 笔内容收入`);
      await load();
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '月度结算失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {contextHolder}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>内容分成与月度结算</Typography.Title>
          <Typography.Text type="secondary">公共剧按总部、代理商、创作者三方结算；私有剧及会员收入不计创作者分成。</Typography.Text>
        </div>
        {canManage ? <Button onClick={() => openPolicy()} type="primary">配置分成策略</Button> : null}
      </div>
      <Alert className="page-alert" message="结算以 UTC 自然月和原币种分别生成。只允许结算已经结束的月份，退款回冲记录不会重复计入。" showIcon />
      <Card className="page-card">
        <Space wrap>
          <Input onChange={(event) => setTenantId(event.target.value)} placeholder="代理商 Tenant UUID（可选筛选）" style={{ width: 330 }} value={tenantId} />
          <Input onChange={(event) => setMonth(event.target.value)} type="month" value={month} />
          <Select onChange={setCurrency} options={currencies.map((value) => ({ label: value, value }))} value={currency} />
          <Button loading={loading} onClick={() => void load()}>查询</Button>
          {canManage ? <Button disabled={!tenantId.trim()} loading={submitting} onClick={() => void settle()}>确认月度结算</Button> : null}
        </Space>
      </Card>
      <Space size="large" wrap style={{ margin: '16px 0' }}>
        <Statistic title={`总收入（${currency} 最小单位）`} value={totals.gross.toString()} />
        <Statistic title="总部份额" value={totals.headquarters.toString()} />
        <Statistic title="代理商份额" value={totals.tenant.toString()} />
        <Statistic title="创作者份额" value={totals.creator.toString()} />
      </Space>
      <Typography.Title level={4}>分成策略</Typography.Title>
      <Table<PolicyRecord>
        columns={[
          { dataIndex: 'tenantId', title: '代理商', width: 290 },
          { dataIndex: 'contentScope', title: '内容', render: (value) => value === 'public' ? '公共剧' : '私有剧' },
          { dataIndex: 'incomeType', title: '收入类型' },
          { key: 'shares', title: '总部 / 代理商 / 创作者', render: (_, row) => `${bpsLabel(row.headquartersBps)} / ${bpsLabel(row.tenantBps)} / ${bpsLabel(row.creatorBps)}` },
          { dataIndex: 'status', title: '状态', render: (value) => <Tag color={value === 'active' ? 'green' : 'default'}>{value === 'active' ? '启用' : '停用'}</Tag> },
          { dataIndex: 'version', title: '版本', width: 70 },
          { key: 'action', title: '操作', render: (_, row) => canManage ? <Button onClick={() => openPolicy(row)} size="small">编辑</Button> : null },
        ]}
        dataSource={policies}
        loading={loading}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1050 }}
      />
      <Typography.Title level={4} style={{ marginTop: 24 }}>逐笔内容收入账本</Typography.Title>
      <Table<LedgerRecord>
        columns={[
          { dataIndex: 'occurredAt', title: '发生时间', width: 180, render: (value) => new Date(value).toLocaleString('zh-CN') },
          { dataIndex: 'tenantId', title: '代理商', width: 290 },
          { dataIndex: 'dramaId', title: '短剧', width: 290 },
          { dataIndex: 'incomeType', title: '类型', width: 120 },
          { key: 'gross', title: '总额', width: 120, render: (_, row) => `${row.grossMinor} ${row.currency}` },
          { key: 'shares', title: '总部 / 代理商 / 创作者', width: 260, render: (_, row) => `${row.headquartersMinor} / ${row.tenantMinor} / ${row.creatorMinor}` },
          { dataIndex: 'status', title: '状态', width: 100, render: (value) => <Tag color={value === 'settled' ? 'green' : value === 'reversed' ? 'red' : 'gold'}>{value}</Tag> },
          { dataIndex: 'sourceId', title: '来源', width: 260, ellipsis: true },
        ]}
        dataSource={ledger}
        loading={loading}
        pagination={{ pageSize: 50 }}
        rowKey="id"
        scroll={{ x: 1650 }}
      />
      <Modal destroyOnHidden footer={null} onCancel={() => setEditing(undefined)} open={Boolean(editing)} title="内容分成策略">
        <Form form={form} layout="vertical" onFinish={(values) => void savePolicy(values)} preserve={false}>
          <Form.Item label="代理商 Tenant UUID" name="tenantId" rules={[{ required: true }]}><Input disabled={editing !== 'create'} /></Form.Item>
          <Space align="start" wrap>
            <Form.Item label="内容范围" name="contentScope" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={[{ label: '公共剧', value: 'public' }, { label: '代理商私有剧', value: 'private' }]} style={{ width: 160 }} /></Form.Item>
            <Form.Item label="收入类型" name="incomeType" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={[{ label: '金币解锁', value: 'coin_unlock' }, { label: '内容广告', value: 'content_ad' }, { label: '会员', value: 'membership' }]} style={{ width: 160 }} /></Form.Item>
            <Form.Item label="状态" name="status" rules={[{ required: true }]}><Select options={[{ label: '启用', value: 'active' }, { label: '停用', value: 'disabled' }]} style={{ width: 120 }} /></Form.Item>
          </Space>
          <Space align="start" wrap>
            <Form.Item label="总部基点" name="headquartersBps" rules={[{ required: true }]}><InputNumber max={10000} min={0} precision={0} /></Form.Item>
            <Form.Item label="代理商基点" name="tenantBps" rules={[{ required: true }]}><InputNumber max={10000} min={0} precision={0} /></Form.Item>
            <Form.Item label="创作者基点" name="creatorBps" rules={[{ required: true }]}><InputNumber max={10000} min={0} precision={0} /></Form.Item>
          </Space>
          <Button block htmlType="submit" loading={submitting} type="primary">保存策略</Button>
        </Form>
      </Modal>
    </>
  );
}

function bpsLabel(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function previousUtcMonth(): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return date.toISOString().slice(0, 7);
}
