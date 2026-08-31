import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  type AnalyticsCurrency,
  type CursorState,
  advanceCursor,
  formatMinorDecimal,
  retreatCursor,
  validateAnalyticsDateRange,
  visibleWithdrawalGroups,
} from './analytics-ui';

interface AmountByCurrency {
  currency: AnalyticsCurrency;
  grossMinor: string;
  netMinor: string;
  refundMinor: string;
}

interface AnalyticsRange {
  from: string;
  fromInclusive: string;
  timeZone: string;
  to: string;
  toExclusive: string;
}

interface AnalyticsOverview {
  commissionBalances: Array<{
    availableMinor: string;
    currency: AnalyticsCurrency;
    pendingMinor: string;
  }>;
  content: { draft: number; pending: number; published: number };
  customers: { new: number; paid: number; total: number };
  daily: Array<{
    amounts: AmountByCurrency[];
    date: string;
    newCustomers: number;
    paidOrders: number;
    refunds: number;
  }>;
  merchantBalances: Array<{
    availableMinor: string;
    currency: AnalyticsCurrency;
    frozenMinor: string;
    pendingMinor: string;
    withdrawnMinor: string;
  }>;
  moneyByCurrency: AmountByCurrency[];
  orders: { paid: number; refunded: number };
  range: AnalyticsRange;
  refundBacklog: { manualReconciliation: number; processing: number };
  tenants?: { active: number; expired: number; suspended: number; total: number };
  withdrawals: Array<{
    amounts: Array<{ amountMinor: string; currency: AnalyticsCurrency }>;
    count: number;
    status: WithdrawalStatus;
  }>;
}

type WithdrawalStatus =
  | 'submitted' | 'reviewing' | 'approved' | 'rejected'
  | 'cancelled' | 'paying' | 'paid' | 'failed';

interface TenantRankingResponse {
  currency: AnalyticsCurrency;
  items: Array<{
    grossMinor: string;
    name: string;
    paidOrders: number;
    status: 'active' | 'expired' | 'suspended';
    tenantId: string;
  }>;
  nextCursor: string | null;
  pageSize: number;
  range: AnalyticsRange;
}

interface AppliedFilters {
  from: string;
  timeZone?: string;
  to: string;
}

const currencies: AnalyticsCurrency[] = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'];
const timeZones = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Seoul',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const initialCursor: CursorState = { current: undefined, history: [] };
const withdrawalLabels: Record<WithdrawalStatus, string> = {
  approved: '已批准', cancelled: '已撤回', failed: '失败', paid: '已打款',
  paying: '打款中', rejected: '已驳回', reviewing: '审核中', submitted: '已提交',
};

export function AnalyticsDashboardPage(props: {
  apiBase: string;
  readPermission: 'platform.analytics.read' | 'tenant.analytics.read';
  scope: 'platform' | 'tenant';
}) {
  const { principal, request } = useAuth();
  const allowed = principal?.permissions.includes(props.readPermission) ?? false;
  const [overview, setOverview] = useState<AnalyticsOverview>();
  const [overviewLoading, setOverviewLoading] = useState(allowed);
  const [overviewError, setOverviewError] = useState<string>();
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [timeZone, setTimeZone] = useState('UTC');
  const [todayLimit, setTodayLimit] = useState('');
  const [applied, setApplied] = useState<AppliedFilters>();
  const overviewSequence = useRef(0);

  const [rankingCurrency, setRankingCurrency] = useState<AnalyticsCurrency>();
  const [tenantIdInput, setTenantIdInput] = useState('');
  const [tenantIdFilter, setTenantIdFilter] = useState('');
  const [ranking, setRanking] = useState<TenantRankingResponse>();
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingError, setRankingError] = useState<string>();
  const [cursorState, setCursorState] = useState<CursorState>(initialCursor);
  const rankingSequence = useRef(0);

  const loadOverview = useCallback(async (filters?: AppliedFilters) => {
    if (!allowed) return;
    const sequence = ++overviewSequence.current;
    setOverviewLoading(true);
    setOverviewError(undefined);
    const parameters = new URLSearchParams();
    if (filters) {
      parameters.set('from', filters.from);
      parameters.set('to', filters.to);
      if (props.scope === 'platform' && filters.timeZone) parameters.set('timeZone', filters.timeZone);
    } else if (props.scope === 'platform') {
      parameters.set('timeZone', 'UTC');
    }
    const query = parameters.size ? `?${parameters}` : '';
    try {
      const result = await request<AnalyticsOverview>(`${props.apiBase}/overview${query}`);
      if (sequence !== overviewSequence.current) return;
      if (props.scope === 'platform') {
        rankingSequence.current += 1;
        setRanking(undefined);
      }
      setOverview(result);
      setDraftFrom(result.range.from);
      setDraftTo(result.range.to);
      setTimeZone(result.range.timeZone);
      setTodayLimit((current) => current || result.range.to);
      setApplied({
        from: result.range.from,
        ...(props.scope === 'platform' ? { timeZone: result.range.timeZone } : {}),
        to: result.range.to,
      });
    } catch (reason) {
      if (sequence === overviewSequence.current) {
        setOverviewError(errorMessage(reason, '经营数据加载失败'));
      }
    } finally {
      if (sequence === overviewSequence.current) setOverviewLoading(false);
    }
  }, [allowed, props.apiBase, props.scope, request]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  function applyDateRange(): void {
    const maximum = props.scope === 'platform' ? todayInTimeZone(timeZone) : todayLimit;
    const validation = validateAnalyticsDateRange(draftFrom, draftTo, maximum);
    if (!validation.valid) {
      setOverviewError(validation.error);
      return;
    }
    void loadOverview({
      from: draftFrom,
      ...(props.scope === 'platform' ? { timeZone } : {}),
      to: draftTo,
    });
  }

  const loadRanking = useCallback(async (cursor?: string) => {
    if (!allowed || props.scope !== 'platform' || !overview || !rankingCurrency) return;
    const sequence = ++rankingSequence.current;
    setRankingLoading(true);
    setRankingError(undefined);
    const parameters = new URLSearchParams({
      currency: rankingCurrency,
      from: overview.range.from,
      pageSize: '20',
      timeZone: overview.range.timeZone,
      to: overview.range.to,
    });
    if (tenantIdFilter) parameters.set('tenantId', tenantIdFilter);
    if (cursor) parameters.set('cursor', cursor);
    try {
      const result = await request<TenantRankingResponse>(`${props.apiBase}/tenants?${parameters}`);
      if (sequence === rankingSequence.current) setRanking(result);
    } catch (reason) {
      if (sequence === rankingSequence.current) {
        setRankingError(errorMessage(reason, '商家排行加载失败'));
        setRanking(undefined);
      }
    } finally {
      if (sequence === rankingSequence.current) setRankingLoading(false);
    }
  }, [allowed, overview, props.apiBase, props.scope, rankingCurrency, request, tenantIdFilter]);

  useEffect(() => {
    if (props.scope !== 'platform' || !overview) return;
    setCursorState(initialCursor);
    if (rankingCurrency) {
      void loadRanking();
    } else {
      rankingSequence.current += 1;
      setRanking(undefined);
      setRankingLoading(false);
      setRankingError(undefined);
    }
  }, [loadRanking, overview, props.scope, rankingCurrency, tenantIdFilter]);

  function applyTenantFilter(value: string): void {
    const normalized = value.trim();
    if (normalized && !UUID_PATTERN.test(normalized)) {
      setRankingError('请输入正确的商家 UUID');
      return;
    }
    rankingSequence.current += 1;
    setRanking(undefined);
    setCursorState(initialCursor);
    setRankingError(undefined);
    setTenantIdFilter(normalized);
  }

  function changeRankingCurrency(value: AnalyticsCurrency): void {
    rankingSequence.current += 1;
    setRanking(undefined);
    setCursorState(initialCursor);
    setRankingError(undefined);
    setRankingCurrency(value);
  }

  function nextRankingPage(): void {
    if (!ranking?.nextCursor || rankingLoading) return;
    const next = advanceCursor(cursorState, ranking.nextCursor);
    setCursorState(next);
    void loadRanking(next.current);
  }

  function previousRankingPage(): void {
    if (!cursorState.history.length || rankingLoading) return;
    const previous = retreatCursor(cursorState);
    setCursorState(previous);
    void loadRanking(previous.current);
  }

  if (!allowed) return null;

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>经营概览</Typography.Title>
          <Typography.Text type="secondary">
            仅展示真实订单、退款、客户、内容与财务汇总，不估算在线人数。
          </Typography.Text>
        </div>
      </div>

      <Card className="page-filter-card" size="small">
        <Space align="end" size={12} wrap>
          <label>
            <Typography.Text type="secondary">开始日期</Typography.Text>
            <Input aria-label="开始日期" max={draftTo || undefined} onChange={(event) => setDraftFrom(event.target.value)}
              type="date" value={draftFrom} />
          </label>
          <label>
            <Typography.Text type="secondary">结束日期</Typography.Text>
            <Input aria-label="结束日期" max={props.scope === 'platform' ? todayInTimeZone(timeZone) : todayLimit || undefined}
              min={draftFrom || undefined} onChange={(event) => setDraftTo(event.target.value)} type="date" value={draftTo} />
          </label>
          {props.scope === 'platform' ? (
            <label>
              <Typography.Text type="secondary">IANA 时区</Typography.Text>
              <Select showSearch onChange={setTimeZone} options={timeZones.map((value) => ({ label: value, value }))}
                style={{ display: 'block', minWidth: 210 }} value={timeZone} />
            </label>
          ) : (
            <Typography.Text type="secondary">商家固定时区：{overview?.range.timeZone ?? '加载中'}</Typography.Text>
          )}
          <Button loading={overviewLoading} onClick={applyDateRange} type="primary">应用（最多 90 天）</Button>
          <Button disabled={!applied} loading={overviewLoading} onClick={() => void loadOverview(applied)}>刷新</Button>
        </Space>
      </Card>

      {overviewError ? (
        <Alert action={<Button size="small" onClick={() => void loadOverview(applied)}>重试</Button>}
          className="page-alert" message={overviewError} showIcon type="error" />
      ) : null}

      {overviewLoading && !overview ? <Spin size="large" /> : overview ? (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            统计区间：{overview.range.from} 至 {overview.range.to} · {overview.range.timeZone}
          </Typography.Text>
          <OverviewCards overview={overview} scope={props.scope} />
          <MoneyCard values={overview.moneyByCurrency} />
          <DailyTable daily={overview.daily} />
          <FinancialCards overview={overview} />
          {props.scope === 'platform' ? (
            <TenantRanking
              currency={rankingCurrency}
              cursorState={cursorState}
              error={rankingError}
              input={tenantIdInput}
              loading={rankingLoading}
              onCurrency={changeRankingCurrency}
              onInput={setTenantIdInput}
              onNext={nextRankingPage}
              onPrevious={previousRankingPage}
              onReload={() => void loadRanking(cursorState.current)}
              onSearch={applyTenantFilter}
              ranking={ranking}
            />
          ) : null}
        </Space>
      ) : null}
    </>
  );
}

function OverviewCards({ overview, scope }: { overview: AnalyticsOverview; scope: 'platform' | 'tenant' }) {
  return (
    <Row gutter={[12, 12]}>
      {scope === 'platform' && overview.tenants ? (
        <Col xs={24} sm={12} xl={6}><Card><Statistic title="商家" value={overview.tenants.total} suffix={`活跃 ${overview.tenants.active}`} />
          <Typography.Text type="secondary">过期 {overview.tenants.expired} · 暂停 {overview.tenants.suspended}</Typography.Text></Card></Col>
      ) : null}
      <Col xs={24} sm={12} xl={6}><Card><Statistic title="客户总数" value={overview.customers.total} suffix={`新增 ${overview.customers.new}`} />
        <Typography.Text type="secondary">区间付费客户 {overview.customers.paid}</Typography.Text></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card><Statistic title="已支付订单" value={overview.orders.paid} suffix={`退款 ${overview.orders.refunded}`} /></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card><Statistic title="退款积压" value={overview.refundBacklog.processing}
        suffix={`人工 ${overview.refundBacklog.manualReconciliation}`} /></Card></Col>
      <Col xs={24} sm={12} xl={6}><Card><Statistic title="已发布内容" value={overview.content.published}
        suffix={`待审 ${overview.content.pending}`} /><Typography.Text type="secondary">草稿 {overview.content.draft}</Typography.Text></Card></Col>
    </Row>
  );
}

function MoneyCard({ values }: { values: AmountByCurrency[] }) {
  return (
    <Card title="交易金额（按币种独立）">
      <Table<AmountByCurrency> columns={[
        { dataIndex: 'currency', title: '币种', width: 90 },
        { dataIndex: 'grossMinor', title: '原始成交', render: (value, row) => minorText(value, row.currency) },
        { dataIndex: 'refundMinor', title: '退款', render: (value, row) => minorText(value, row.currency) },
        { dataIndex: 'netMinor', title: '净额', render: (value, row) => <Typography.Text strong>{minorText(value, row.currency)}</Typography.Text> },
      ]} dataSource={values} locale={{ emptyText: <Empty description="该区间暂无交易金额" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={false} rowKey="currency" size="small" />
    </Card>
  );
}

function DailyTable({ daily }: { daily: AnalyticsOverview['daily'] }) {
  return (
    <Card title="每日趋势">
      <Table<AnalyticsOverview['daily'][number]> columns={[
        { dataIndex: 'date', title: '日期', width: 120 },
        { dataIndex: 'newCustomers', title: '新客户', width: 90 },
        { dataIndex: 'paidOrders', title: '支付订单', width: 90 },
        { dataIndex: 'refunds', title: '退款数', width: 80 },
        { dataIndex: 'amounts', title: '分币种 gross / refund / net', render: (amounts: AmountByCurrency[]) => amounts.length ? (
          <Space direction="vertical" size={2}>{amounts.map((amount) => (
            <Typography.Text key={amount.currency}>{amount.currency}：{minorText(amount.grossMinor, amount.currency)} / {minorText(amount.refundMinor, amount.currency)} / {minorText(amount.netMinor, amount.currency)}</Typography.Text>
          ))}</Space>
        ) : <Typography.Text type="secondary">—</Typography.Text> },
      ]} dataSource={daily} locale={{ emptyText: <Empty description="暂无每日数据" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{ defaultPageSize: 14, pageSizeOptions: [7, 14, 30, 60, 90], showSizeChanger: true }}
        rowKey="date" size="small" scroll={{ x: 900 }} />
    </Card>
  );
}

function FinancialCards({ overview }: { overview: AnalyticsOverview }) {
  const withdrawals = visibleWithdrawalGroups(overview.withdrawals);
  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={12}>
        <Card title="商家余额（按币种）">
          <Table dataSource={overview.merchantBalances} columns={[
            { dataIndex: 'currency', title: '币种' },
            { dataIndex: 'pendingMinor', title: '待结算', render: (value, row) => minorText(value, row.currency) },
            { dataIndex: 'availableMinor', title: '可用', render: (value, row) => minorText(value, row.currency) },
            { dataIndex: 'frozenMinor', title: '冻结', render: (value, row) => minorText(value, row.currency) },
            { dataIndex: 'withdrawnMinor', title: '已提现', render: (value, row) => minorText(value, row.currency) },
          ]} locale={{ emptyText: '暂无商家余额' }} pagination={false} rowKey="currency" size="small" scroll={{ x: 720 }} />
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card title="分销佣金余额（按币种）">
          <Table dataSource={overview.commissionBalances} columns={[
            { dataIndex: 'currency', title: '币种' },
            { dataIndex: 'pendingMinor', title: '待结算', render: (value, row) => minorText(value, row.currency) },
            { dataIndex: 'availableMinor', title: '可用', render: (value, row) => minorText(value, row.currency) },
          ]} locale={{ emptyText: '暂无佣金余额' }} pagination={false} rowKey="currency" size="small" />
        </Card>
      </Col>
      <Col span={24}>
        <Card title="提现汇总（按状态和币种）">
          <Table dataSource={withdrawals} columns={[
            { dataIndex: 'status', title: '状态', render: (value: WithdrawalStatus) => withdrawalLabels[value] },
            { dataIndex: 'count', title: '单数' },
            { dataIndex: 'amounts', title: '分币种金额', render: (amounts: AnalyticsOverview['withdrawals'][number]['amounts']) => (
              <Space direction="vertical" size={2}>{amounts.map((amount) => (
                <Typography.Text key={amount.currency}>{minorText(amount.amountMinor, amount.currency)}</Typography.Text>
              ))}</Space>
            ) },
          ]} locale={{ emptyText: '暂无提现记录' }} pagination={false} rowKey="status" size="small" />
        </Card>
      </Col>
    </Row>
  );
}

function TenantRanking(props: {
  currency?: AnalyticsCurrency;
  cursorState: CursorState;
  error?: string;
  input: string;
  loading: boolean;
  onCurrency: (value: AnalyticsCurrency) => void;
  onInput: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onReload: () => void;
  onSearch: (value: string) => void;
  ranking?: TenantRankingResponse;
}) {
  return (
    <Card title="商家成交排行（单币种）">
      <div className="tenant-content-toolbar">
        <Select options={currencies.map((value) => ({ label: value, value }))} placeholder="先选币种" style={{ width: 120 }}
          value={props.currency} onChange={props.onCurrency} />
        <Input.Search allowClear onChange={(event) => {
          props.onInput(event.target.value);
          if (!event.target.value) props.onSearch('');
        }} onSearch={props.onSearch} placeholder="精确商家 UUID（可选）" style={{ maxWidth: 330 }} value={props.input} />
        <Button disabled={!props.currency} loading={props.loading} onClick={props.onReload}>刷新</Button>
      </div>
      {props.error ? <Alert action={<Button size="small" onClick={props.onReload}>重试</Button>}
        className="page-alert" message={props.error} showIcon type="error" /> : null}
      <Table<TenantRankingResponse['items'][number]> columns={[
        { dataIndex: 'name', title: '商家', render: (value, row) => (
          <Space direction="vertical" size={0}><Typography.Text strong>{value}</Typography.Text>
            <Typography.Text copyable type="secondary">{row.tenantId}</Typography.Text></Space>
        ) },
        { dataIndex: 'status', title: '状态', render: (value) => <Tag color={value === 'active' ? 'green' : value === 'expired' ? 'orange' : 'red'}>
          {value === 'active' ? '活跃' : value === 'expired' ? '过期' : '暂停'}</Tag> },
        { dataIndex: 'paidOrders', title: '已支付订单' },
        { dataIndex: 'grossMinor', title: `${props.currency ?? '所选币种'} 原始成交`, render: (value) => props.currency ? minorText(value, props.currency) : '—' },
      ]} dataSource={props.ranking?.items ?? []} loading={props.loading}
        locale={{ emptyText: <Empty description={props.currency ? '当前条件暂无商家数据' : '请先选择一个币种'} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={false} rowKey="tenantId" size="small" />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={!props.cursorState.history.length || props.loading} onClick={props.onPrevious}>上一页</Button>
        <Typography.Text type="secondary">第 {props.cursorState.history.length + 1} 页</Typography.Text>
        <Button disabled={!props.ranking?.nextCursor || props.loading} onClick={props.onNext}>下一页</Button>
      </Space>
    </Card>
  );
}

function minorText(value: string, currency: AnalyticsCurrency): string {
  try {
    return formatMinorDecimal(value, currency);
  } catch {
    return `${currency} 数据格式异常`;
  }
}

function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit', month: '2-digit', timeZone, year: 'numeric',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
