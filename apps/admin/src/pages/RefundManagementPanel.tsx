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

export type CollectionMode = 'platform_collect' | 'tenant_direct';
export type RefundStatus = 'failed' | 'manual_reconciliation' | 'processing' | 'succeeded';

export interface RefundRecord {
  amountMinor: number;
  collectionMode: CollectionMode;
  createdAt: string;
  currency: string;
  fullRefund: true;
  id: string;
  manualReconciliation: boolean;
  orderId: string;
  reason: string;
  reconciliationRequired: boolean;
  status: RefundStatus;
}

export function canStartTenantFullRefund(
  order: { collectionMode?: CollectionMode; status: string },
  hasExistingRefund: boolean,
): boolean {
  return order.status === 'paid'
    && order.collectionMode === 'tenant_direct'
    && !hasExistingRefund;
}

interface RefundListResponse {
  items: RefundRecord[];
  page: number;
  pageSize: number;
}

interface RefundFormValues {
  orderId: string;
  reason: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusLabels: Record<RefundStatus, { color?: string; label: string }> = {
  failed: { color: 'red', label: '失败' },
  manual_reconciliation: { color: 'orange', label: '需人工对账' },
  processing: { color: 'blue', label: '处理中' },
  succeeded: { color: 'green', label: '已成功' },
};

export function RefundManagementPanel(props: {
  apiBase: string;
  canManage: boolean;
  canRead: boolean;
  mode: 'platform' | 'tenant';
  onRecordsChange?: (records: RefundRecord[]) => void;
  onRefundCreated?: () => void | Promise<void>;
  refreshKey?: number;
}) {
  const { request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const [form] = Form.useForm<RefundFormValues>();
  const [items, setItems] = useState<RefundRecord[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState<RefundStatus>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<RefundRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const load = useCallback(async (nextPage = page, nextPageSize = pageSize) => {
    if (!props.canRead) return;
    const sequence = ++listSequence.current;
    setLoading(true);
    setError(undefined);
    const parameters = new URLSearchParams({ page: String(nextPage), pageSize: String(nextPageSize) });
    if (status) parameters.set('status', status);
    try {
      const result = await request<RefundListResponse>(`${props.apiBase}/refunds?${parameters}`);
      if (sequence === listSequence.current) {
        setItems(result.items);
        setPage(result.page);
        setPageSize(result.pageSize);
        props.onRecordsChange?.(result.items);
      }
    } catch (reason) {
      if (sequence === listSequence.current) setError(refundError(reason, '退款列表加载失败'));
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, [page, pageSize, props.apiBase, props.canRead, props.onRecordsChange, request, status]);

  useEffect(() => {
    void load(1, pageSize);
  // Refresh key and filters deliberately return to the first page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey, status]);

  const loadDetail = useCallback(async (refundId: string) => {
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const result = await request<RefundRecord>(`${props.apiBase}/refunds/${encodeURIComponent(refundId)}`);
      if (sequence === detailSequence.current) setDetail(result);
    } catch (reason) {
      if (sequence === detailSequence.current) setDetailError(refundError(reason, '退款详情加载失败'));
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, [props.apiBase, request]);

  function openDetail(refundId: string): void {
    detailSequence.current += 1;
    setDetailId(refundId);
    setDetail(undefined);
    void loadDetail(refundId);
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    setDetailId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
  }

  function openCreate(): void {
    form.resetFields();
    setCreateOpen(true);
  }

  function closeCreate(): void {
    if (submitting) return;
    form.resetFields();
    setCreateOpen(false);
  }

  function confirmCreate(values: RefundFormValues): void {
    const known = items.find((item) => item.orderId === values.orderId.trim());
    if (known) {
      messageApi.warning(`该订单已有退款记录（${statusLabels[known.status].label}），不可重复发起。`);
      return;
    }
    modalApi.confirm({
      content: '系统将按服务端订单金额发起全额退款，不允许在后台修改金额。模糊结果将进入人工对账。',
      okButtonProps: { danger: true },
      okText: '确认发起全额退款',
      onOk: () => createRefund(values),
      title: '二次确认：全额退款',
    });
  }

  async function createRefund(values: RefundFormValues): Promise<void> {
    setSubmitting(true);
    try {
      const result = await request<RefundRecord>(
        `${props.apiBase}/orders/${encodeURIComponent(values.orderId.trim())}/refunds`,
        { body: JSON.stringify({ reason: values.reason.trim() }), method: 'POST' },
      );
      form.resetFields();
      setCreateOpen(false);
      if (result.reconciliationRequired || result.manualReconciliation) {
        messageApi.warning('退款结果尚未明确，已进入人工对账；请勿重复发起。');
      } else {
        messageApi.success(result.status === 'succeeded' ? '全额退款已成功' : '全额退款已发起，正在处理');
      }
      await Promise.all([load(1, pageSize), props.onRefundCreated?.()]);
    } catch (reason) {
      messageApi.error(refundError(reason, '全额退款发起失败'));
      await load(1, pageSize);
    } finally {
      setSubmitting(false);
    }
  }

  if (!props.canRead) return null;

  return (
    <>
      {messageContext}
      {modalContext}
      <Card
        className="todo-card"
        extra={props.mode === 'platform' && props.canManage
          ? <Button danger onClick={openCreate}>发起全额退款</Button> : null}
        title="全额退款"
      >
        <Alert
          className="page-alert"
          description="退款金额完全由服务端已支付订单决定；处理中或需人工对账的订单不可重复发起。"
          message={props.mode === 'platform' ? '平台只处理平台代收订单' : '代理商只处理独立直收订单'}
          showIcon
          type="info"
        />
        <div className="tenant-content-toolbar">
          <Select<RefundStatus> allowClear onChange={setStatus}
            options={Object.entries(statusLabels).map(([value, item]) => ({ label: item.label, value }))}
            placeholder="全部状态" style={{ width: 160 }} value={status} />
          <Button loading={loading} onClick={() => void load(page, pageSize)}>刷新</Button>
        </div>
        {error ? <Alert action={<Button size="small" onClick={() => void load(page, pageSize)}>重试</Button>}
          className="page-alert" message={error} showIcon type="error" /> : null}
        <Table<RefundRecord>
          columns={[
            { dataIndex: 'id', title: '退款单', render: (value: string) => (
              <Button className="table-link-button" type="link" onClick={() => openDetail(value)}>{value}</Button>
            ) },
            { dataIndex: 'orderId', title: '订单 UUID', render: (value: string) => <Typography.Text copyable>{value}</Typography.Text> },
            { key: 'amount', title: '服务端金额', render: (_, record) => formatMoney(record.amountMinor, record.currency) },
            { dataIndex: 'collectionMode', title: '收款模式', render: (value: CollectionMode) => value === 'platform_collect' ? '平台代收' : '代理商直收' },
            { dataIndex: 'status', title: '状态', render: (value: RefundStatus) => <RefundStatusTag status={value} /> },
            { dataIndex: 'createdAt', title: '发起时间', render: formatDateTime, width: 180 },
            { key: 'action', title: '操作', width: 80, render: (_, record) => <Button size="small" onClick={() => openDetail(record.id)}>详情</Button> },
          ]}
          dataSource={items}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无退款记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={{
            current: page,
            onChange: (nextPage, nextSize) => void load(nextPage, nextSize),
            pageSize,
            showSizeChanger: true,
            total: (page - 1) * pageSize + items.length + (items.length === pageSize ? 1 : 0),
          }}
          rowKey="id"
          scroll={{ x: 1150 }}
        />
      </Card>

      <Drawer destroyOnHidden onClose={closeDetail} open={Boolean(detailId)} title="退款详情" width={700}>
        {detailLoading ? <Spin /> : detailError ? (
          <Alert action={<Button size="small" onClick={() => detailId && void loadDetail(detailId)}>重试</Button>}
            message={detailError} showIcon type="error" />
        ) : detail ? <RefundDetail record={detail} /> : null}
      </Drawer>

      <Modal destroyOnHidden footer={null} onCancel={closeCreate} open={createOpen} title="平台代收订单全额退款">
        <Alert className="page-alert" message="仅输入订单 UUID 和原因，金额不可输入或修改。" showIcon type="warning" />
        <Form form={form} layout="vertical" onFinish={confirmCreate} requiredMark={false}>
          <Form.Item label="订单 UUID" name="orderId" rules={[
            { required: true, message: '请输入订单 UUID' },
            { pattern: UUID_PATTERN, message: '请输入正确 UUID' },
          ]}><Input maxLength={36} /></Form.Item>
          <Form.Item label="退款原因" name="reason" rules={[
            { required: true, message: '请输入退款原因', whitespace: true },
            { min: 2, max: 2000, message: '2–2000 字' },
          ]}><Input.TextArea maxLength={2000} rows={4} showCount /></Form.Item>
          <Button danger htmlType="submit" loading={submitting} block>进入二次确认</Button>
        </Form>
      </Modal>
    </>
  );
}

function RefundDetail({ record }: { record: RefundRecord }) {
  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      {record.reconciliationRequired || record.manualReconciliation ? (
        <Alert description="渠道结果尚未明确，请进行人工对账，不要重复发起退款。"
          message="需要人工对账" showIcon type="warning" />
      ) : null}
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="退款 UUID" span={2}><Typography.Text copyable>{record.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="订单 UUID" span={2}><Typography.Text copyable>{record.orderId}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="状态"><RefundStatusTag status={record.status} /></Descriptions.Item>
        <Descriptions.Item label="类型">{record.fullRefund ? '全额退款' : '—'}</Descriptions.Item>
        <Descriptions.Item label="收款模式">{record.collectionMode === 'platform_collect' ? '平台代收' : '代理商直收'}</Descriptions.Item>
        <Descriptions.Item label="服务端金额"><Typography.Text strong>{formatMoney(record.amountMinor, record.currency)}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="发起时间" span={2}>{formatDateTime(record.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="原因" span={2}><Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{record.reason}</Typography.Paragraph></Descriptions.Item>
      </Descriptions>
    </Space>
  );
}

function RefundStatusTag({ status }: { status: RefundStatus }) {
  const item = statusLabels[status];
  return <Tag color={item.color}>{item.label}</Tag>;
}

function formatMoney(amountMinor: number, currency: string): string {
  const fractionDigits = ['JPY', 'KRW'].includes(currency.toUpperCase()) ? 0 : 2;
  try {
    return new Intl.NumberFormat('zh-CN', { currency, style: 'currency' }).format(amountMinor / (10 ** fractionDigits));
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function refundError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback;
  if (reason.status === 409) return '订单已有退款、状态已变更或当前不允许退款；请刷新后核对，不要重复发起。';
  if (reason.status === 403) return '当前账号无权执行该退款操作。';
  if (reason.status === 404) return '未找到可操作的订单或退款记录。';
  if (reason.status === 400) return '退款请求不符合服务端规则，请检查订单和原因。';
  return fallback;
}
