import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';

import { useAuth } from '../auth/AuthProvider';
import { MerchantSelect } from './MerchantSelect';
import { dateTimeFormProps } from './ContentScheduleFields';
import { formatBpsAsPercent, parsePercentToBps } from './referral-ui';
import { revenueIncomeLabels, revenueStatusLabels, revenueMajor, revenueMinor, revenueMoney } from './revenue-ui';

const API_BASE = '/api/v1/platform/content-revenue';
const currencies = Intl.supportedValuesOf('currency');

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
  creatorPercent: string;
  headquartersPercent: string;
  incomeType: PolicyRecord['incomeType'];
  status: PolicyRecord['status'];
  tenantPercent: string;
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
  const [allTotals, setAllTotals] = useState<Array<{ currency: string; gross: string; headquarters: string; tenant: string; creator: string }>>([]);
  const [editing, setEditing] = useState<PolicyRecord | 'create'>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cashStatus, setCashStatus] = useState<{ basis: 'gross' | 'net' | null; unvalued: number; legacyReview: string | null }>();
  const [selectedBasis, setSelectedBasis] = useState<'gross' | 'net'>();
  const [statementForm] = Form.useForm<Record<string, string>>();
  const statementCurrency = Form.useWatch('currency', statementForm) ?? 'USD';
  const [report, setReport] = useState<{ kind: 'statements' | 'ad-statements' | 'legacy-review'; tenant: string }>();
  const [sources, setSources] = useState<Array<{ id: string; currency: string; gross_minor: string; sandbox: boolean }>>([]);
  const canManage = principal?.permissions.includes('finance.settlement.manage') ?? false;
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setCashStatus(undefined); setSelectedBasis(undefined);
    try {
      const query = new URLSearchParams();
      if (tenantId.trim()) query.set('tenantId', tenantId.trim());
      if (month) query.set('month', month);
      const policyQuery = tenantId.trim() ? `?tenantId=${encodeURIComponent(tenantId.trim())}` : '';
      const [policyResult, ledgerResult] = await Promise.all([
        request<{ items: PolicyRecord[] }>(`${API_BASE}/policies${policyQuery}`),
        request<{ items: LedgerRecord[]; totals: typeof allTotals }>(`${API_BASE}/ledger?${query}`),
      ]);
      if (sequence !== loadSequence.current) return;
      setPolicies(policyResult.items);
      setLedger(ledgerResult.items);
      setAllTotals(ledgerResult.totals);
      if (tenantId.trim()) {
        const cash = await request<{ basis: 'gross' | 'net' | null; unvalued: number; legacyReview: string | null }>(
          `${API_BASE}/cash-status/${encodeURIComponent(tenantId.trim())}`);
        if (sequence !== loadSequence.current) return;
        setCashStatus(cash); setSelectedBasis(cash.basis ?? undefined);
      } else { setCashStatus(undefined); setSelectedBasis(undefined); }
    } catch (reason) {
      if (sequence === loadSequence.current) messageApi.error(reason instanceof Error ? reason.message : '内容分成数据加载失败');
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [messageApi, month, request, tenantId]);

  useEffect(() => { void load(); return () => { loadSequence.current++; }; }, [load]);

  const totals = allTotals.find(item => item.currency === currency)
    ?? { creator: '0', gross: '0', headquarters: '0', tenant: '0' };

  function openPolicy(record?: PolicyRecord) {
    const selected = record ?? {
      contentScope: 'public' as const, creatorBps: 2000, headquartersBps: 2000,
      incomeType: 'coin_unlock' as const, status: 'active' as const, tenantBps: 6000,
      tenantId: tenantId.trim(),
    };
    form.setFieldsValue({ ...selected, creatorPercent: formatBpsAsPercent(selected.creatorBps),
      headquartersPercent: formatBpsAsPercent(selected.headquartersBps), tenantPercent: formatBpsAsPercent(selected.tenantBps) });
    setEditing(record ?? 'create');
  }

  async function savePolicy(values: PolicyFormValue) {
    let shares: { headquartersBps: number; tenantBps: number; creatorBps: number };
    try { shares = { headquartersBps: parsePercentToBps(values.headquartersPercent),
      tenantBps: parsePercentToBps(values.tenantPercent), creatorBps: parsePercentToBps(values.creatorPercent) }; }
    catch (reason) { messageApi.error(reason instanceof Error ? reason.message : '分成比例无效'); return; }
    const total = shares.headquartersBps + shares.tenantBps + shares.creatorBps;
    if (total !== 10_000) {
      messageApi.error('总部、代理商、创作者分成比例合计必须等于 100%');
      return;
    }
    if ((values.contentScope === 'private' || values.incomeType === 'membership') && shares.creatorBps !== 0) {
      messageApi.error('私有剧和会员收入的创作者分成必须为 0%'); return;
    }
    setSubmitting(true);
    try {
      await request(`${API_BASE}/policies/${encodeURIComponent(values.tenantId.trim())}`, {
        body: JSON.stringify({
          contentScope: values.contentScope, incomeType: values.incomeType, status: values.status, ...shares,
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
      messageApi.warning('请先选择需要结算的代理商');
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

  async function configureCash(action: 'basis' | 'reconcile') {
    if (!tenantId.trim() || (action === 'basis' && !selectedBasis)) return;
    setSubmitting(true);
    try {
      await request(`${API_BASE}/${action}/${encodeURIComponent(tenantId.trim())}`, {
        method: 'PUT', body: JSON.stringify(action === 'basis' ? { basis: selectedBasis } : {}),
      });
      messageApi.success(action === 'basis' ? '分成基数已保存，已入账事实不变' : '已核算一批待入账记录；缺净收入凭据的记录仍保留待核算');
      await load();
    } catch (reason) { messageApi.error(reason instanceof Error ? reason.message : '核算失败'); }
    finally { setSubmitting(false); }
  }

  async function openReport(kind: 'statements' | 'ad-statements' | 'legacy-review') {
    const tenant = tenantId.trim();
    if (!tenant) return;
    statementForm.resetFields(); statementForm.setFieldsValue({ currency }); setSources([]); setReport({ kind, tenant });
    if (kind === 'statements') {
      try { setSources((await request<{ items: typeof sources }>(`${API_BASE}/sources/${encodeURIComponent(tenant)}`)).items); }
      catch { messageApi.error('现金来源加载失败，请关闭后重试'); }
    }
  }
  async function submitReport(values: Record<string, string>) {
    if (!report) return;
    setSubmitting(true);
    try {
      const body = Object.fromEntries(Object.entries(values).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value.trim()]));
      if (values.grossMajor) body.grossMinor = revenueMinor(values.grossMajor, values.currency!);
      if (values.netMajor) body.netMinor = revenueMinor(values.netMajor, values.currency!);
      delete body.grossMajor; delete body.netMajor;
      await request(`${API_BASE}/${report.kind}/${encodeURIComponent(report.tenant)}`, { method: 'POST', body: JSON.stringify(body) });
      setReport(undefined); messageApi.success('总部核对凭据已记录；待核算记录需单独执行核算'); await load();
    } catch (reason) { messageApi.error(reason instanceof Error ? reason.message : '凭据记录失败'); }
    finally { setSubmitting(false); }
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
          <MerchantSelect onChange={setTenantId} placeholder="全部代理商；可按名称筛选" value={tenantId} />
          <DatePicker aria-label="结算月份" picker="month" allowClear={false} value={dayjs(`${month}-01`)} onChange={value => { if (value) setMonth(value.format('YYYY-MM')); }} />
          <Select showSearch onChange={setCurrency} options={currencies.map((value) => ({ label: value, value }))} value={currency} />
          <Button loading={loading} onClick={() => void load()}>查询</Button>
          {canManage ? <Button disabled={!tenantId.trim() || loading || !cashStatus || Boolean(cashStatus.unvalued || cashStatus.legacyReview)} loading={submitting} onClick={() => void settle()}>确认月度结算</Button> : null}
        </Space>
      </Card>
      {cashStatus ? <Card className="page-card" title="实收来源与核算">
        <Alert showIcon type={cashStatus.unvalued || cashStatus.legacyReview ? 'warning' : 'info'}
          message={`待核算 ${cashStatus.unvalued} 笔；${cashStatus.legacyReview ? '存在历史资金待核对，禁止月结。' : '赠送/人工调整金币不产生现金分成。'}`}
          description="必须明确选择实付金额或扣商店手续费后的净收入。缺少凭据时不推算净收入；恢复核算会对未配置过策略的历史事件采用当前策略，已保存快照不变。" />
        {canManage ? <Space wrap style={{ marginTop: 12 }}>
          <Select style={{ width: 310 }} placeholder="请选择分成基数" value={selectedBasis} onChange={setSelectedBasis}
            options={[{ value: 'gross', label: '用户实付金额（退款另行冲正）' }, { value: 'net', label: '商店手续费后净收入（需结算凭据）' }]} />
          <Button disabled={!selectedBasis} loading={submitting} onClick={() => void configureCash('basis')}>保存分成基数</Button>
          <Button disabled={!cashStatus.basis || !cashStatus.unvalued} loading={submitting} onClick={() => void configureCash('reconcile')}>按已确认策略核算 500 笔</Button>
          <Button onClick={() => void openReport('statements')}>录入商店净收入凭据</Button>
          <Button onClick={() => void openReport('ad-statements')}>录入内容广告对账行</Button>
          {cashStatus.legacyReview ? <Button disabled={Boolean(cashStatus.unvalued)} onClick={() => void openReport('legacy-review')}>确认历史核对报告</Button> : null}
        </Space> : null}
      </Card> : null}
      <Modal title="总部财务凭据登记" open={Boolean(report)} onCancel={() => !submitting && setReport(undefined)}
        onOk={() => statementForm.submit()} confirmLoading={submitting} okText="确认已核对并登记" destroyOnClose>
        <Alert showIcon type="warning" message="仅登记已经人工核对的商店或广告财务报表；报表编号与 SHA256 是留档索引，不代表系统已向渠道核验文件。提交后原事实不可覆盖。" />
        <Typography.Paragraph>代理商：{report?.tenant}</Typography.Paragraph>
        <Form name="contentrevenuepage-1" form={statementForm} layout="vertical" onFinish={submitReport}>
          {report?.kind === 'statements' ? <Form.Item name="sourceId" label="现金来源（最近 100 笔）" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={sources.filter(source => !source.sandbox).map(source => ({
              value: source.id, label: source.id + ' · ' + revenueMoney(source.gross_minor, source.currency),
            }))} onChange={id => { const source = sources.find(item => item.id === id); if (source) statementForm.setFieldsValue({ currency: source.currency, grossMajor: revenueMajor(source.gross_minor, source.currency), netMajor: undefined }); }} />
          </Form.Item> : null}
          {report?.kind !== 'legacy-review' ? <>
            <Form.Item name="currency" label="币种" rules={[{ required: true }]}><Select showSearch options={currencies.map(value => ({ value, label: value }))} onChange={() => statementForm.setFieldsValue({ grossMajor: undefined, netMajor: undefined })} /></Form.Item>
            <Form.Item name="grossMajor" label={`原始实收（${statementCurrency}）`} rules={[{ required: true }, { validator: async (_, value) => { if (value) revenueMinor(value, statementCurrency); } }]}><Input inputMode="decimal" /></Form.Item>
            <Form.Item name="netMajor" label={`手续费后净收入（${statementCurrency}）`} rules={[{ required: report?.kind === 'statements' }, { validator: async (_, value) => { if (value) revenueMinor(value, statementCurrency); } }]}><Input inputMode="decimal" /></Form.Item>
            <Form.Item name="rowId" label="报表行唯一编号" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
          </> : null}
          {report?.kind === 'ad-statements' ? <>
            <Form.Item name="dramaId" label="关联短剧编号" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="episodeId" label="关联剧集编号（可选）"><Input /></Form.Item>
            <Form.Item name="occurredAt" label="收入发生时间" {...dateTimeFormProps} rules={[{ required: true }]}><DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} /></Form.Item>
          </> : null}
          <Form.Item name="reportId" label="已归档报表 / 核对报告编号" rules={[{ required: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="reportSha256" label="报表文件 SHA256" rules={[{ required: true }, { pattern: /^[a-f0-9]{64}$/ }]}><Input maxLength={64} /></Form.Item>
        </Form>
      </Modal>
      <Space size="large" wrap style={{ margin: '16px 0' }}>
        <Statistic title="总收入" value={0} formatter={() => revenueMoney(totals.gross, currency)} />
        <Statistic title="总部份额" value={0} formatter={() => revenueMoney(totals.headquarters, currency)} />
        <Statistic title="代理商份额" value={0} formatter={() => revenueMoney(totals.tenant, currency)} />
        <Statistic title="创作者份额" value={0} formatter={() => revenueMoney(totals.creator, currency)} />
      </Space>
      <Typography.Title level={4}>分成策略</Typography.Title>
      <Table<PolicyRecord>
        columns={[
          { dataIndex: 'tenantId', title: '代理商', width: 290 },
          { dataIndex: 'contentScope', title: '内容', render: (value) => value === 'public' ? '公共剧' : '私有剧' },
          { dataIndex: 'incomeType', title: '收入类型', render: value => revenueIncomeLabels[value] ?? '其他收入' },
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
      <Typography.Title level={4} style={{ marginTop: 24 }}>逐笔内容收入账本（最近 1000 笔；上方汇总包含全部匹配记录）</Typography.Title>
      <Table<LedgerRecord>
        columns={[
          { dataIndex: 'occurredAt', title: '发生时间', width: 180, render: (value) => new Date(value).toLocaleString('zh-CN') },
          { dataIndex: 'tenantId', title: '代理商', width: 290 },
          { dataIndex: 'dramaId', title: '短剧', width: 290 },
          { dataIndex: 'incomeType', title: '类型', width: 120, render: value => revenueIncomeLabels[value] ?? '其他收入' },
          { key: 'gross', title: '总额', width: 120, render: (_, row) => revenueMoney(row.grossMinor, row.currency) },
          { key: 'shares', title: '总部 / 代理商 / 创作者', width: 260, render: (_, row) => `${revenueMoney(row.headquartersMinor, row.currency)} / ${revenueMajor(row.tenantMinor, row.currency)} / ${revenueMajor(row.creatorMinor, row.currency)}` },
          { dataIndex: 'status', title: '状态', width: 100, render: (value) => <Tag color={value === 'settled' ? 'green' : value === 'reversed' ? 'red' : 'gold'}>{revenueStatusLabels[value] ?? '未知状态'}</Tag> },
          { dataIndex: 'sourceId', title: '来源', width: 260, ellipsis: true },
        ]}
        dataSource={ledger}
        loading={loading}
        pagination={{ pageSize: 50 }}
        rowKey="id"
        scroll={{ x: 1650 }}
      />
      <Modal destroyOnHidden footer={null} onCancel={() => setEditing(undefined)} open={Boolean(editing)} title="内容分成策略">
        <Form name="contentrevenuepage-2" form={form} layout="vertical" onFinish={(values) => void savePolicy(values)} preserve={false}>
          <Form.Item label="代理商" name="tenantId" rules={[{ required: true, message: '请选择代理商' }]}><MerchantSelect disabled={editing !== 'create'} /></Form.Item>
          <Space align="start" wrap>
            <Form.Item label="内容范围" name="contentScope" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={[{ label: '公共剧', value: 'public' }, { label: '代理商私有剧', value: 'private' }]} style={{ width: 160 }} /></Form.Item>
            <Form.Item label="收入类型" name="incomeType" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={[{ label: '金币解锁', value: 'coin_unlock' }, { label: '内容广告', value: 'content_ad' }, { label: '会员', value: 'membership' }]} style={{ width: 160 }} /></Form.Item>
            <Form.Item label="状态" name="status" rules={[{ required: true }]}><Select options={[{ label: '启用', value: 'active' }, { label: '停用', value: 'disabled' }]} style={{ width: 120 }} /></Form.Item>
          </Space>
          <Space align="start" wrap>
            <Form.Item label="总部比例（%）" name="headquartersPercent" rules={[{ required: true }]}><Input inputMode="decimal" suffix="%" /></Form.Item>
            <Form.Item label="代理商比例（%）" name="tenantPercent" rules={[{ required: true }]}><Input inputMode="decimal" suffix="%" /></Form.Item>
            <Form.Item label="创作者比例（%）" name="creatorPercent" rules={[{ required: true }]}><Input inputMode="decimal" suffix="%" /></Form.Item>
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
