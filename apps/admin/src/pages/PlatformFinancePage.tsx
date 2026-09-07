import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { MerchantSelect } from './MerchantSelect';
import {
  currencies,
  type Currency,
  formatDateTime,
  formatMoney,
  WithdrawalDetail,
  type WithdrawalRecord,
  type WithdrawalStatus,
  withdrawalStatusOptions,
  WithdrawalStatusTag,
} from './finance-ui';
import { RefundManagementPanel } from './RefundManagementPanel';

const API_BASE = '/api/v1/platform/finance';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PayoutAccount {
  accountHolder: string;
  accountNumber: string;
  bankName: string;
  countryCode: string;
  routingCode?: string;
}

interface PayoutAccountResponse {
  id: string;
  payoutAccount: PayoutAccount;
}

interface ReviewFormValues {
  decision: 'approve' | 'reject';
  reason?: string;
}

interface TransferFormValues {
  bankReference: string;
  mediaAssetId: string;
}

interface SettlementRunFormValues {
  currency?: Currency;
  limit: number;
  tenantId?: string;
}

interface SettlementPolicyFormValues {
  currency: Currency;
  delayDays: number;
  tenantId: string;
}

interface SettlementPolicyResult extends SettlementPolicyFormValues {
  version: number;
}

export function PlatformFinancePage() {
  const { principal, request } = useAuth();
  const [reviewForm] = Form.useForm<ReviewFormValues>();
  const [transferForm] = Form.useForm<TransferFormValues>();
  const [settlementForm] = Form.useForm<SettlementRunFormValues>();
  const [policyForm] = Form.useForm<SettlementPolicyFormValues>();
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<WithdrawalStatus>();
  const [tenantIdInput, setTenantIdInput] = useState('');
  const [tenantIdFilter, setTenantIdFilter] = useState('');
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<WithdrawalRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [payoutAccount, setPayoutAccount] = useState<PayoutAccountResponse>();
  const [payoutLoading, setPayoutLoading] = useState(false);
  const [payoutError, setPayoutError] = useState<string>();
  const [reviewTarget, setReviewTarget] = useState<WithdrawalRecord>();
  const [reviewDecision, setReviewDecision] = useState<'approve' | 'reject'>('approve');
  const [transferTarget, setTransferTarget] = useState<WithdrawalRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const [lastSettlementCount, setLastSettlementCount] = useState<number>();
  const [lastPolicy, setLastPolicy] = useState<SettlementPolicyResult>();
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const payoutSequence = useRef(0);
  const detailIdRef = useRef<string | undefined>(undefined);

  const canRead = principal?.permissions.includes('finance.withdrawal.read') ?? false;
  const canReadPayout = principal?.permissions.includes(
    'finance.withdrawal.payout_account.read',
  ) ?? false;
  const canReview = principal?.permissions.includes('finance.withdrawal.review') ?? false;
  const canConfirmTransfer = principal?.permissions.includes(
    'finance.withdrawal.confirm_transfer',
  ) ?? false;
  const canManageSettlements = principal?.permissions.includes('finance.settlement.manage') ?? false;
  const canReadRefunds = principal?.permissions.includes('finance.refund.read') ?? false;
  const canManageRefunds = principal?.permissions.includes('finance.refund.manage') ?? false;

  const loadWithdrawals = useCallback(async () => {
    if (!canRead) return;
    const sequence = ++listSequence.current;
    setLoading(true);
    setError(undefined);
    const parameters = new URLSearchParams({ limit: '100' });
    if (status) parameters.set('status', status);
    if (tenantIdFilter) parameters.set('tenantId', tenantIdFilter);
    try {
      const result = await request<WithdrawalRecord[]>(`${API_BASE}/withdrawals?${parameters}`);
      if (sequence === listSequence.current) setWithdrawals(result);
    } catch (reason) {
      if (sequence === listSequence.current) {
        setError(errorMessage(reason, '提现审核列表加载失败'));
      }
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, [canRead, request, status, tenantIdFilter]);

  useEffect(() => {
    void loadWithdrawals();
  }, [loadWithdrawals]);

  const loadDetail = useCallback(async (withdrawalId: string) => {
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const result = await request<WithdrawalRecord>(
        `${API_BASE}/withdrawals/${encodeURIComponent(withdrawalId)}`,
      );
      if (sequence === detailSequence.current && detailIdRef.current === withdrawalId) {
        setDetail(result);
      }
    } catch (reason) {
      if (sequence === detailSequence.current) {
        setDetailError(errorMessage(reason, '提现详情加载失败'));
      }
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, [request]);

  function clearPayoutAccount(): void {
    payoutSequence.current += 1;
    setPayoutAccount(undefined);
    setPayoutError(undefined);
    setPayoutLoading(false);
  }

  function openDetail(record: WithdrawalRecord): void {
    detailSequence.current += 1;
    clearPayoutAccount();
    detailIdRef.current = record.id;
    setDetailId(record.id);
    setDetail(undefined);
    void loadDetail(record.id);
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    clearPayoutAccount();
    detailIdRef.current = undefined;
    setDetailId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(false);
  }

  function confirmPayoutAccess(): void {
    if (!detailId || !canReadPayout) return;
    modalApi.confirm({
      content: '本操作会解密并展示完整收款账户，系统将记录审计日志。请确认当前审核确实需要。',
      okButtonProps: { danger: true },
      okText: '确认解密查看',
      onOk: () => loadPayoutAccount(detailId),
      title: '二次确认：查看敏感收款账户',
    });
  }

  async function loadPayoutAccount(withdrawalId: string): Promise<void> {
    const sequence = ++payoutSequence.current;
    setPayoutLoading(true);
    setPayoutError(undefined);
    setPayoutAccount(undefined);
    try {
      const result = await request<PayoutAccountResponse>(
        `${API_BASE}/withdrawals/${encodeURIComponent(withdrawalId)}/payout-account`,
      );
      if (sequence === payoutSequence.current && detailIdRef.current === withdrawalId) {
        setPayoutAccount(result);
      }
    } catch (reason) {
      if (sequence === payoutSequence.current && detailIdRef.current === withdrawalId) {
        setPayoutError(errorMessage(reason, '收款账户加载失败'));
      }
    } finally {
      if (sequence === payoutSequence.current) setPayoutLoading(false);
    }
  }

  function openReview(record: WithdrawalRecord, decision: 'approve' | 'reject'): void {
    reviewForm.resetFields();
    reviewForm.setFieldsValue({ decision });
    setReviewDecision(decision);
    setReviewTarget(record);
  }

  async function submitReview(values: ReviewFormValues): Promise<void> {
    if (!reviewTarget) return;
    setSubmitting(`review:${reviewTarget.id}`);
    try {
      await request(`${API_BASE}/withdrawals/${encodeURIComponent(reviewTarget.id)}/review`, {
        body: JSON.stringify({
          decision: values.decision,
          ...(values.decision === 'reject' ? { reason: values.reason?.trim() } : {}),
          version: reviewTarget.version,
        }),
        method: 'POST',
      });
      messageApi.success(values.decision === 'approve' ? '提现已批准' : '提现已驳回');
      const targetId = reviewTarget.id;
      setReviewTarget(undefined);
      reviewForm.resetFields();
      if (detailIdRef.current === targetId) {
        clearPayoutAccount();
        await loadDetail(targetId);
      }
      await loadWithdrawals();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '审核操作失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function openTransfer(record: WithdrawalRecord): void {
    transferForm.resetFields();
    setTransferTarget(record);
  }

  function confirmTransfer(values: TransferFormValues): void {
    if (!transferTarget) return;
    modalApi.confirm({
      content: `确认已完成真实银行打款，并将提现单 ${transferTarget.withdrawalNo} 标记为已打款？此操作会更新真实余额账本。`,
      okButtonProps: { danger: true },
      okText: '确认已打款',
      onOk: () => submitTransfer(values),
      title: '二次确认：确认转账',
    });
  }

  async function submitTransfer(values: TransferFormValues): Promise<void> {
    if (!transferTarget) return;
    const target = transferTarget;
    setSubmitting(`transfer:${target.id}`);
    try {
      await request(`${API_BASE}/withdrawals/${encodeURIComponent(target.id)}/confirm-transfer`, {
        body: JSON.stringify({
          bankReference: values.bankReference.trim(),
          mediaAssetId: values.mediaAssetId.trim(),
          version: target.version,
        }),
        method: 'POST',
      });
      messageApi.success('打款已确认，余额记录已更新');
      setTransferTarget(undefined);
      transferForm.resetFields();
      if (detailIdRef.current === target.id) {
        clearPayoutAccount();
        await loadDetail(target.id);
      }
      await loadWithdrawals();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '确认打款失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function confirmRunSettlements(values: SettlementRunFormValues): void {
    modalApi.confirm({
      content: '系统只会处理已到期的待结算记录，并真实更新代理商可用余额。',
      okText: '确认执行',
      onOk: () => runSettlements(values),
      title: '确认手动运行到期结算？',
    });
  }

  async function runSettlements(values: SettlementRunFormValues): Promise<void> {
    setSubmitting('settlements');
    try {
      const result = await request<{ settled: number }>(`${API_BASE}/settlements/run`, {
        body: JSON.stringify({
          ...(values.currency ? { currency: values.currency } : {}),
          limit: values.limit,
          ...(values.tenantId?.trim() ? { tenantId: values.tenantId.trim() } : {}),
        }),
        method: 'POST',
      });
      setLastSettlementCount(result.settled);
      messageApi.success(`本次已结算 ${result.settled} 条`);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '手动结算执行失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function savePolicy(values: SettlementPolicyFormValues): Promise<void> {
    setSubmitting('policy');
    try {
      const tenantId = values.tenantId.trim();
      const result = await request<SettlementPolicyResult>(
        `${API_BASE}/settlements/policies/${encodeURIComponent(tenantId)}`,
        {
          body: JSON.stringify({ currency: values.currency, delayDays: values.delayDays }),
          method: 'PUT',
        },
      );
      setLastPolicy(result);
      messageApi.success('结算延迟策略已保存');
    } catch (reason) {
      messageApi.error(errorMessage(reason, '结算策略保存失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  const canReviewRecord = (record: WithdrawalRecord) =>
    canReview && ['submitted', 'reviewing'].includes(record.status);
  const canTransferRecord = (record: WithdrawalRecord) =>
    canConfirmTransfer && ['approved', 'paying', 'failed'].includes(record.status);

  return (
    <>
      {messageContext}
      {modalContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>财务与提现</Typography.Title>
          <Typography.Text type="secondary">
            处理提现审核、打款登记和到期结算。
          </Typography.Text>
        </div>
      </div>

      {canRead ? (
        <Card title="提现审核">
          <div className="tenant-content-toolbar">
            <Select<WithdrawalStatus>
              allowClear
              onChange={(value) => {
                listSequence.current += 1;
                setWithdrawals([]);
                setStatus(value);
              }}
              options={withdrawalStatusOptions}
              placeholder="全部状态"
              style={{ width: 140 }}
              value={status}
            />
            <MerchantSelect
              onChange={(value) => {
                setTenantIdInput(value);
                listSequence.current += 1;
                setWithdrawals([]);
                setTenantIdFilter(value);
              }}
              value={tenantIdInput}
            />
            <Button loading={loading} onClick={() => void loadWithdrawals()}>刷新</Button>
          </div>
          {error ? (
            <Alert
              action={<Button size="small" onClick={() => void loadWithdrawals()}>重试</Button>}
              className="page-alert"
              message={error}
              showIcon
              type="error"
            />
          ) : null}
          <Table<WithdrawalRecord>
            columns={[
              {
                dataIndex: 'withdrawalNo',
                title: '提现单',
                render: (value: string, record) => (
                  <Space direction="vertical" size={0}>
                    <Button className="table-link-button" type="link" onClick={() => openDetail(record)}>{value}</Button>
                    <Typography.Text className="secondary-id" type="secondary">{record.id}</Typography.Text>
                  </Space>
                ),
              },
              {
                dataIndex: 'tenantId',
                title: '代理商',
                render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
              },
              {
                key: 'amount',
                title: '金额',
                render: (_: unknown, record) => formatMoney(record.amountMinor, record.currency),
              },
              { dataIndex: 'status', title: '状态', render: (value) => <WithdrawalStatusTag status={value} /> },
              { dataIndex: 'payoutAccountFingerprint', title: '收款账户指纹' },
              { dataIndex: 'submittedAt', title: '提交时间', render: formatDateTime, width: 180 },
              {
                key: 'actions',
                title: '操作',
                width: 220,
                render: (_: unknown, record) => (
                  <Space size={6} wrap>
                    <Button disabled={Boolean(submitting)} size="small" onClick={() => openDetail(record)}>详情</Button>
                    {canReviewRecord(record) ? (
                      <>
                        <Button disabled={Boolean(submitting)} size="small" type="primary" onClick={() => openReview(record, 'approve')}>批准</Button>
                        <Button danger disabled={Boolean(submitting)} size="small" onClick={() => openReview(record, 'reject')}>驳回</Button>
                      </>
                    ) : null}
                    {canTransferRecord(record) ? (
                      <Button danger disabled={Boolean(submitting)} size="small" onClick={() => openTransfer(record)}>确认打款</Button>
                    ) : null}
                  </Space>
                ),
              },
            ]}
            dataSource={withdrawals}
            loading={loading}
            locale={{ emptyText: <Empty description="暂无提现申请" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            pagination={false}
            rowKey="id"
            scroll={{ x: 1250 }}
          />
        </Card>
      ) : null}

      {canManageSettlements ? (
        <Card className="todo-card" title="结算管理">
          {lastSettlementCount !== undefined ? (
            <Alert
              closable
              className="page-alert"
              message={`上次手动运行完成，结算 ${lastSettlementCount} 条到期记录。`}
              onClose={() => setLastSettlementCount(undefined)}
              showIcon
              type="success"
            />
          ) : null}
          {lastPolicy ? (
            <Alert
              closable
              className="page-alert"
              message={`结算规则已保存：${lastPolicy.currency} · 收款后 ${lastPolicy.delayDays} 天可结算`}
              onClose={() => setLastPolicy(undefined)}
              showIcon
              type="success"
            />
          ) : null}
          <Row gutter={[24, 24]}>
            <Col xs={24} xl={12}>
              <Typography.Title level={5}>手动运行到期结算</Typography.Title>
              <Typography.Paragraph type="secondary">
                处理已到结算日期的待结算记录。
              </Typography.Paragraph>
              <Form<SettlementRunFormValues>
                name="platformfinancepage-1" form={settlementForm}
                initialValues={{ limit: 50 }}
                layout="vertical"
                onFinish={confirmRunSettlements}
                requiredMark={false}
              >
                <Form.Item label="代理商（可选）" name="tenantId" rules={[
                  { pattern: UUID_PATTERN, message: '请输入正确 UUID' },
                ]}>
                  <MerchantSelect placeholder="全部代理商；可按名称筛选" />
                </Form.Item>
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item label="币种（可选）" name="currency">
                      <Select allowClear options={currencies.map((currency) => ({ label: currency, value: currency }))} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="最多处理条数" name="limit" rules={[{ required: true }]}>
                      <InputNumber max={100} min={1} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Button disabled={Boolean(submitting)} htmlType="submit" loading={submitting === 'settlements'} type="primary">
                  运行到期结算
                </Button>
              </Form>
            </Col>
            <Col xs={24} xl={12}>
              <Typography.Title level={5}>代理商结算延迟策略</Typography.Title>
              <Typography.Paragraph type="secondary">
                按代理商和币种设置 T+N 天（0–90），再次保存会更新现有策略。
              </Typography.Paragraph>
              <Form<SettlementPolicyFormValues>
                name="platformfinancepage-2" form={policyForm}
                initialValues={{ currency: 'USD', delayDays: 0 }}
                layout="vertical"
                onFinish={(values) => void savePolicy(values)}
                requiredMark={false}
              >
                <Form.Item label="代理商" name="tenantId" rules={[
                  { required: true, message: '请选择代理商' },
                  { pattern: UUID_PATTERN, message: '请输入正确 UUID' },
                ]}>
                  <MerchantSelect />
                </Form.Item>
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item label="币种" name="currency" rules={[{ required: true }]}>
                      <Select options={currencies.map((currency) => ({ label: currency, value: currency }))} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item label="延迟天数" name="delayDays" rules={[{ required: true }]}>
                      <InputNumber max={90} min={0} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                </Row>
                <Button disabled={Boolean(submitting)} htmlType="submit" loading={submitting === 'policy'} type="primary">
                  保存结算策略
                </Button>
              </Form>
            </Col>
          </Row>
        </Card>
      ) : null}

      <RefundManagementPanel
        apiBase={API_BASE}
        canManage={canManageRefunds}
        canRead={canReadRefunds}
        mode="platform"
      />

      <Drawer
        destroyOnHidden
        extra={detail ? (
          <Space wrap>
            {canReadPayout ? (
              payoutAccount ? (
                <Button danger disabled={Boolean(submitting)} onClick={clearPayoutAccount}>立即隐藏账户</Button>
              ) : (
                <Button danger disabled={Boolean(submitting)} loading={payoutLoading} onClick={confirmPayoutAccess}>
                  查看完整收款账户
                </Button>
              )
            ) : null}
            {canReviewRecord(detail) ? (
              <>
                <Button disabled={Boolean(submitting)} type="primary" onClick={() => openReview(detail, 'approve')}>批准</Button>
                <Button danger disabled={Boolean(submitting)} onClick={() => openReview(detail, 'reject')}>驳回</Button>
              </>
            ) : null}
            {canTransferRecord(detail) ? (
              <Button danger disabled={Boolean(submitting)} onClick={() => openTransfer(detail)}>确认打款</Button>
            ) : null}
          </Space>
        ) : null}
        onClose={closeDetail}
        open={Boolean(detailId)}
        title="提现审核详情"
        width={820}
      >
        {detailLoading ? <Spin /> : detailError ? (
          <Alert
            action={<Button size="small" onClick={() => detailId && void loadDetail(detailId)}>重试</Button>}
            message={detailError}
            showIcon
            type="error"
          />
        ) : detail ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <WithdrawalDetail withdrawal={detail} />
            {payoutError ? (
              <Alert
                action={<Button danger size="small" onClick={confirmPayoutAccess}>重新确认并加载</Button>}
                message={payoutError}
                showIcon
                type="error"
              />
            ) : null}
            {payoutLoading ? <Spin tip="正在安全解密收款账户…" /> : null}
            {payoutAccount ? (
              <Card title="敏感收款账户" type="inner">
                <Alert
                  className="page-alert"
                  message="仅用于当前审核；关闭详情后页面会立即清除这些数据。"
                  showIcon
                  type="warning"
                />
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="收款人">{payoutAccount.payoutAccount.accountHolder}</Descriptions.Item>
                  <Descriptions.Item label="银行">{payoutAccount.payoutAccount.bankName}</Descriptions.Item>
                  <Descriptions.Item label="完整账号">
                    <Typography.Text copyable>{payoutAccount.payoutAccount.accountNumber}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="国家/地区">{payoutAccount.payoutAccount.countryCode}</Descriptions.Item>
                  <Descriptions.Item label="Routing Code">
                    {payoutAccount.payoutAccount.routingCode || '—'}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ) : null}
          </Space>
        ) : null}
      </Drawer>

      <Modal
        cancelText="取消"
        destroyOnHidden
        okButtonProps={{ danger: reviewDecision === 'reject' }}
        okText={reviewDecision === 'approve' ? '批准提现' : '驳回提现'}
        confirmLoading={submitting === `review:${reviewTarget?.id}`}
        onCancel={() => {
          if (!submitting) setReviewTarget(undefined);
        }}
        onOk={() => reviewForm.submit()}
        open={Boolean(reviewTarget)}
        title={reviewDecision === 'approve' ? '批准提现' : '驳回提现'}
      >
        <Form<ReviewFormValues>
          name="platformfinancepage-3" form={reviewForm}
          layout="vertical"
          onFinish={(values) => void submitReview(values)}
          requiredMark={false}
        >
          <Form.Item label="审核决定" name="decision">
            <Radio.Group disabled>
              <Radio value="approve">批准</Radio>
              <Radio value="reject">驳回</Radio>
            </Radio.Group>
          </Form.Item>
          {reviewDecision === 'reject' ? (
            <Form.Item
              label="驳回原因"
              name="reason"
              rules={[
                { required: true, message: '请输入驳回原因', whitespace: true },
                { min: 2, max: 2000, message: '2–2000 字' },
              ]}
            >
              <Input.TextArea maxLength={2000} rows={4} showCount />
            </Form.Item>
          ) : (
            <Alert
              message="批准后仍需完成实际打款，再登记凭证并确认打款结果。"
              showIcon
              type="info"
            />
          )}
        </Form>
      </Modal>

      <Modal
        cancelText="取消"
        destroyOnHidden
        footer={null}
        onCancel={() => {
          if (!submitting) {
            setTransferTarget(undefined);
            transferForm.resetFields();
          }
        }}
        open={Boolean(transferTarget)}
        title="确认银行打款"
      >
        <Alert
          className="page-alert"
          description="请先完成打款，再上传打款凭证并确认。此操作会将申请标记为已支付。"
          message="确认打款结果"
          showIcon
          type="error"
        />
        <Form<TransferFormValues>
          name="platformfinancepage-4" form={transferForm}
          layout="vertical"
          onFinish={confirmTransfer}
          requiredMark={false}
        >
          <Form.Item
            label="打款凭证素材编号"
            name="mediaAssetId"
            rules={[
              { required: true, message: '请输入凭证 Media Asset ID' },
              { pattern: UUID_PATTERN, message: '请输入正确 UUID' },
            ]}
          >
            <Input maxLength={36} />
          </Form.Item>
          <Form.Item
            label="银行参考号"
            name="bankReference"
            rules={[
              { required: true, message: '请输入银行参考号', whitespace: true },
              { min: 3, max: 200, message: '3–200 字' },
            ]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Divider />
          <Button danger htmlType="submit" loading={submitting === `transfer:${transferTarget?.id}`} block>
            进入二次确认
          </Button>
        </Form>
      </Modal>
    </>
  );
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
