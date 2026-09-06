import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  type CollectionMode,
  canStartTenantFullRefund,
  type RefundRecord,
  RefundManagementPanel,
} from './RefundManagementPanel';

type OrderStatus = 'cancelled' | 'expired' | 'paid' | 'pending_payment' | 'refunded';
type OrderType = 'membership' | 'drama' | 'episode' | 'points_topup';

interface OrderItemSummary {
  id: string;
  name?: string;
  type: OrderType;
  unitAmountMinor: number;
}

interface TenantOrderSummary {
  accountId: string;
  cancelledAt?: string;
  collectionMode?: CollectionMode;
  createdAt: string;
  currency: string;
  customer: Record<string, unknown>;
  discountMinor: number;
  expiresAt: string;
  id: string;
  item: OrderItemSummary;
  locale: string;
  orderNo: string;
  orderType: OrderType;
  paidAt?: string;
  refundedAt?: string;
  status: OrderStatus;
  subtotalMinor: number;
  totalMinor: number;
  updatedAt: string;
  version: number;
}

interface TenantOrderDetail extends TenantOrderSummary {
  items: Array<{
    createdAt: string;
    currency: string;
    id: string;
    lineNo: number;
    product: Record<string, unknown> & { id: string; name?: string; type: OrderType };
    quantity: number;
    totalAmountMinor: number;
    unitAmountMinor: number;
  }>;
}

interface OrderListResponse {
  items: TenantOrderSummary[];
  page: number;
  pageSize: number;
  total: number;
}

const API_BASE = '/api/v1/tenant/commerce/orders';
interface NativeOrder {
  id: string; store: string; environment: string; store_product_id: string; kind: OrderType;
  currency: string; gross_minor: string; refunded_minor: string; status: string; purchased_at: string;
}
const emptyData: OrderListResponse = { items: [], page: 1, pageSize: 20, total: 0 };
const statusLabels: Record<OrderStatus, { color?: string; label: string }> = {
  cancelled: { label: '已取消' },
  expired: { label: '已过期' },
  paid: { color: 'green', label: '已支付' },
  pending_payment: { color: 'gold', label: '待支付' },
  refunded: { color: 'blue', label: '已退款' },
};
const typeLabels: Record<OrderType, string> = {
  drama: '短剧',
  episode: '单集',
  membership: '会员套餐',
  points_topup: '积分充值',
};

export function CommerceOrderPage() {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const [refundForm] = Form.useForm<{ reason: string }>();
  const canReadOrders = principal?.permissions.includes('commerce.order.read') ?? false;
  const canReadRefunds = principal?.permissions.includes('commerce.refund.read') ?? false;
  const canManageRefunds = principal?.permissions.includes('commerce.refund.manage') ?? false;
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(canReadOrders);
  const [error, setError] = useState<string>();
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<OrderStatus>();
  const [orderType, setOrderType] = useState<OrderType>();
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<TenantOrderDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [refundTarget, setRefundTarget] = useState<TenantOrderDetail>();
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundRefreshKey, setRefundRefreshKey] = useState(0);
  const [knownRefundOrderIds, setKnownRefundOrderIds] = useState<Set<string>>(() => new Set());
  const requestSequence = useRef(0);
  const pageSizeRef = useRef(20);

  const load = useCallback(async (page = 1, pageSize = pageSizeRef.current) => {
    if (!canReadOrders) return;
    const sequence = ++requestSequence.current;
    pageSizeRef.current = pageSize;
    setLoading(true);
    setError(undefined);
    const parameters = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) parameters.set('q', q);
    if (status) parameters.set('status', status);
    if (orderType) parameters.set('orderType', orderType);
    try {
      const result = await request<OrderListResponse>(`${API_BASE}?${parameters}`);
      if (sequence === requestSequence.current) setData(result);
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(errorMessage(reason, '订单加载失败'));
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [canReadOrders, orderType, q, request, status]);

  useEffect(() => {
    void load(1);
  }, [load]);

  const loadDetail = useCallback(async (orderId: string) => {
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      setDetail(await request<TenantOrderDetail>(`${API_BASE}/${encodeURIComponent(orderId)}`));
    } catch (reason) {
      setDetailError(errorMessage(reason, '订单详情加载失败'));
    } finally {
      setDetailLoading(false);
    }
  }, [request]);

  function openDetail(orderId: string): void {
    setDetailId(orderId);
    setDetail(undefined);
    void loadDetail(orderId);
  }

  function closeDetail(): void {
    setDetailId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
  }

  function openRefund(order: TenantOrderDetail): void {
    if (!canManageRefunds || !canStartTenantFullRefund(order, knownRefundOrderIds.has(order.id))) return;
    refundForm.resetFields();
    setRefundTarget(order);
  }

  function closeRefund(): void {
    if (refundSubmitting) return;
    refundForm.resetFields();
    setRefundTarget(undefined);
  }

  function confirmRefund(values: { reason: string }): void {
    if (!refundTarget) return;
    modalApi.confirm({
      content: `将按服务端订单 ${refundTarget.orderNo} 的实付金额 ${formatMoney(refundTarget.totalMinor, refundTarget.currency)} 发起全额退款。金额不可在后台修改。`,
      okButtonProps: { danger: true },
      okText: '确认发起全额退款',
      onOk: () => submitRefund(values),
      title: '二次确认：代理商直收订单退款',
    });
  }

  async function submitRefund(values: { reason: string }): Promise<void> {
    if (!refundTarget) return;
    const orderId = refundTarget.id;
    setRefundSubmitting(true);
    try {
      const result = await request<RefundRecord>(
        `/api/v1/tenant/commerce/orders/${encodeURIComponent(orderId)}/refunds`,
        { body: JSON.stringify({ reason: values.reason.trim() }), method: 'POST' },
      );
      setKnownRefundOrderIds((current) => new Set(current).add(orderId));
      refundForm.resetFields();
      setRefundTarget(undefined);
      if (result.reconciliationRequired || result.manualReconciliation) {
        messageApi.warning('渠道结果尚未明确，已进入人工对账；请勿重复发起。');
      } else {
        messageApi.success(result.status === 'succeeded' ? '全额退款已成功' : '全额退款已发起，正在处理');
      }
      setRefundRefreshKey((value) => value + 1);
      await Promise.all([load(data.page, data.pageSize), detailId ? loadDetail(detailId) : Promise.resolve()]);
    } catch (reason) {
      messageApi.error(refundCreateError(reason));
      setRefundRefreshKey((value) => value + 1);
    } finally {
      setRefundSubmitting(false);
    }
  }

  return (
    <>
      {messageContext}
      {modalContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>订单管理</Typography.Title>
          <Typography.Text type="secondary">
            只读查看当前代理商的服务端订单快照，不在后台模拟支付或改价。
          </Typography.Text>
        </div>
      </div>

      {canReadOrders ? (
        <>
      <NativeOrderPanel />
      <div className="tenant-content-toolbar">
        <Input.Search
          allowClear
          onChange={(event) => {
            setQInput(event.target.value);
            if (!event.target.value) setQ('');
          }}
          onSearch={(value) => setQ(value.trim())}
          placeholder="订单号 / 用户名 / 邮箱 / 手机"
          style={{ maxWidth: 340 }}
          value={qInput}
        />
        <Select<OrderStatus>
          allowClear
          onChange={setStatus}
          options={Object.entries(statusLabels).map(([value, option]) => ({
            label: option.label,
            value,
          }))}
          placeholder="订单状态"
          style={{ width: 130 }}
          value={status}
        />
        <Select<OrderType>
          allowClear
          onChange={setOrderType}
          options={Object.entries(typeLabels).map(([value, label]) => ({ label, value }))}
          placeholder="商品类型"
          style={{ width: 140 }}
          value={orderType}
        />
        <Button loading={loading} onClick={() => void load(data.page, data.pageSize)}>刷新</Button>
      </div>

      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load(data.page, data.pageSize)}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}

      <Table<TenantOrderSummary>
        columns={[
          {
            key: 'order',
            title: '订单',
            render: (_, order) => (
              <Space direction="vertical" size={0}>
                <Typography.Text copyable strong>{order.orderNo}</Typography.Text>
                <Typography.Text type="secondary">{formatDateTime(order.createdAt)}</Typography.Text>
              </Space>
            ),
          },
          {
            key: 'customer',
            title: '客户',
            render: (_, order) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{customerText(order.customer, 'username') || order.accountId}</Typography.Text>
                <Typography.Text type="secondary">
                  {customerText(order.customer, 'email') || customerText(order.customer, 'phone') || '无联系方式'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            key: 'product',
            title: '商品',
            render: (_, order) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{order.item.name || typeLabels[order.orderType]}</Typography.Text>
                <Typography.Text type="secondary">{typeLabels[order.orderType]}</Typography.Text>
              </Space>
            ),
          },
          {
            key: 'amount',
            title: '实付金额',
            width: 135,
            render: (_, order) => (
              <Typography.Text strong>{formatMoney(order.totalMinor, order.currency)}</Typography.Text>
            ),
          },
          {
            dataIndex: 'status',
            title: '状态',
            width: 100,
            render: (value: OrderStatus) => (
              <Tag color={statusLabels[value].color}>{statusLabels[value].label}</Tag>
            ),
          },
          {
            key: 'action',
            title: '操作',
            width: 90,
            render: (_, order) => <Button size="small" onClick={() => openDetail(order.id)}>详情</Button>,
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无订单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: (page, pageSize) => void load(page, pageSize),
          pageSize: data.pageSize,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 笔`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1000 }}
      />
        </>
      ) : null}

      <RefundManagementPanel
        apiBase="/api/v1/tenant/commerce"
        canManage={canManageRefunds}
        canRead={canReadRefunds}
        mode="tenant"
        onRecordsChange={(records) => {
          setKnownRefundOrderIds((current) => {
            const next = new Set(current);
            records.forEach((record) => next.add(record.orderId));
            return next;
          });
        }}
        refreshKey={refundRefreshKey}
      />

      {canReadOrders ? <Drawer
        extra={detail && canManageRefunds ? (
          canStartTenantFullRefund(detail, false) ? (
            <Button danger disabled={knownRefundOrderIds.has(detail.id)} onClick={() => openRefund(detail)}>
              {knownRefundOrderIds.has(detail.id) ? '已有退款记录' : '全额退款'}
            </Button>
          ) : null
        ) : null}
        onClose={closeDetail}
        open={Boolean(detailId)}
        title="订单详情"
        width={720}
      >
        {detailLoading ? <Spin /> : detailError ? (
          <Alert
            action={<Button size="small" onClick={() => detailId && void loadDetail(detailId)}>重试</Button>}
            message={detailError}
            showIcon
            type="error"
          />
        ) : detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {canManageRefunds && detail.status === 'paid' && !detail.collectionMode ? (
              <Alert message="订单尚无已成功收款模式快照，不能安全发起退款。" showIcon type="warning" />
            ) : null}
            {detail.collectionMode === 'platform_collect' ? (
              <Alert message="该订单由平台代收，需由总后台发起退款。" showIcon type="info" />
            ) : null}
            <OrderDetail detail={detail} />
          </Space>
        ) : null}
      </Drawer> : null}

      {canReadOrders ? <Modal destroyOnHidden footer={null} onCancel={closeRefund} open={Boolean(refundTarget)} title="代理商直收订单全额退款">
        <Alert className="page-alert" description="不提供金额输入；退款金额仅使用服务端订单实付快照。"
          message={refundTarget ? `${refundTarget.orderNo} · ${formatMoney(refundTarget.totalMinor, refundTarget.currency)}` : '—'}
          showIcon type="warning" />
        <Form form={refundForm} layout="vertical" onFinish={confirmRefund} requiredMark={false}>
          <Form.Item label="退款原因" name="reason" rules={[
            { required: true, message: '请输入退款原因', whitespace: true },
            { min: 2, max: 2000, message: '2–2000 字' },
          ]}><Input.TextArea maxLength={2000} rows={4} showCount /></Form.Item>
          <Button danger htmlType="submit" loading={refundSubmitting} block>进入二次确认</Button>
        </Form>
      </Modal> : null}
    </>
  );
}

function NativeOrderPanel() {
  const { request } = useAuth();
  const [rows, setRows] = useState<NativeOrder[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try { setRows((await request<{ items: NativeOrder[] }>('/api/v1/tenant/commerce/native-store/transactions')).items); }
    catch { setError('商店交易加载失败，请重试'); }
    finally { setLoading(false); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);
  return <Card title="Apple / Google 商店交易（最近 100 笔）" className="page-card"
    extra={<Button loading={loading} onClick={() => void load()}>刷新商店交易</Button>}>
    <Typography.Paragraph type="secondary">商店退款由商店处理，服务端验签后回收权益并冲正；与下方渠道订单分开记录。金额为各币种最小单位。</Typography.Paragraph>
    {error ? <Alert type="error" showIcon message={error} /> : null}
    <Table<NativeOrder> size="small" rowKey="id" loading={loading} dataSource={rows} scroll={{ x: 800 }} pagination={{ pageSize: 10 }}
      columns={[
        { dataIndex: 'id', title: '交易记录', ellipsis: true },
        { dataIndex: 'store', title: '商店', width: 80 },
        { dataIndex: 'environment', title: '环境', width: 95, render: value => <Tag color={value === 'Sandbox' ? 'orange' : 'green'}>{value === 'Sandbox' ? '测试' : '正式'}</Tag> },
        { dataIndex: 'store_product_id', title: '商店 SKU', ellipsis: true },
        { title: '实付 / 已退', render: (_, row) => row.gross_minor + ' / ' + row.refunded_minor + ' ' + row.currency },
        { dataIndex: 'status', title: '状态', width: 100 },
        { dataIndex: 'purchased_at', title: '购买时间', render: value => formatDateTime(value) },
      ]} />
  </Card>;
}

function OrderDetail({ detail }: { detail: TenantOrderDetail }) {
  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="订单号" span={2}>{detail.orderNo}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusLabels[detail.status].color}>{statusLabels[detail.status].label}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="商品类型">{typeLabels[detail.orderType]}</Descriptions.Item>
        <Descriptions.Item label="收款模式" span={2}>
          {detail.collectionMode === 'tenant_direct' ? '代理商直收'
            : detail.collectionMode === 'platform_collect' ? '平台代收' : '尚无成功收款快照'}
        </Descriptions.Item>
        <Descriptions.Item label="小计">{formatMoney(detail.subtotalMinor, detail.currency)}</Descriptions.Item>
        <Descriptions.Item label="优惠">{formatMoney(detail.discountMinor, detail.currency)}</Descriptions.Item>
        <Descriptions.Item label="订单总额" span={2}>
          <Typography.Text strong>{formatMoney(detail.totalMinor, detail.currency)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatDateTime(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="失效时间">{formatDateTime(detail.expiresAt)}</Descriptions.Item>
        <Descriptions.Item label="支付时间">{formatOptionalTime(detail.paidAt)}</Descriptions.Item>
        <Descriptions.Item label="取消时间">{formatOptionalTime(detail.cancelledAt)}</Descriptions.Item>
        <Descriptions.Item label="退款时间">{formatOptionalTime(detail.refundedAt)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{formatDateTime(detail.updatedAt)}</Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Title level={5}>客户快照</Typography.Title>
        <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="用户名">{customerText(detail.customer, 'username') || '—'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{customerText(detail.customer, 'email') || '—'}</Descriptions.Item>
          <Descriptions.Item label="手机">{customerText(detail.customer, 'phone') || '—'}</Descriptions.Item>
          <Descriptions.Item label="账号 UUID">{detail.accountId}</Descriptions.Item>
        </Descriptions>
      </div>

      <div>
        <Typography.Title level={5}>商品快照</Typography.Title>
        <Table
          columns={[
            { dataIndex: 'lineNo', title: '#', width: 50 },
            {
              dataIndex: 'product',
              title: '商品',
              render: (product: TenantOrderDetail['items'][number]['product']) => product.name || typeLabels[product.type],
            },
            { dataIndex: 'quantity', title: '数量', width: 70 },
            {
              key: 'unit',
              title: '单价',
              render: (_, item: TenantOrderDetail['items'][number]) => formatMoney(item.unitAmountMinor, item.currency),
            },
            {
              key: 'total',
              title: '小计',
              render: (_, item: TenantOrderDetail['items'][number]) => formatMoney(item.totalAmountMinor, item.currency),
            },
          ]}
          dataSource={detail.items}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </div>
    </Space>
  );
}

function customerText(customer: Record<string, unknown>, field: string): string | undefined {
  const value = customer[field];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function formatMoney(amountMinor: number, currency: string): string {
  const fractionDigits = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  try {
    return new Intl.NumberFormat('zh-CN', {
      currency,
      style: 'currency',
    }).format(amountMinor / (10 ** fractionDigits));
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function formatOptionalTime(value?: string): string {
  return value ? formatDateTime(value) : '—';
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function refundCreateError(reason: unknown): string {
  if (!(reason instanceof ApiError)) return '全额退款发起失败';
  if (reason.status === 409) return '订单已有退款或状态已变更；请刷新核对，不要重复发起。';
  if (reason.status === 403) return '当前账号无权发起退款。';
  if (reason.status === 404) return '未找到可退款的代理商直收订单。';
  if (reason.status === 400) return '该订单不符合全额退款规则，请刷新后核对。';
  return '全额退款发起失败';
}
