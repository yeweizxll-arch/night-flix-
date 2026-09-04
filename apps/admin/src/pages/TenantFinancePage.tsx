import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
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
  currencies,
  type Currency,
  formatDateTime,
  formatMoney,
  fractionDigits,
  parseMajorAmount,
  WithdrawalDetail,
  type WithdrawalRecord,
  WithdrawalStatusTag,
} from './finance-ui';

const API_BASE = '/api/v1/tenant/finance';

interface BalanceRecord {
  availableMinor: number;
  currency: Currency;
  frozenMinor: number;
  pendingMinor: number;
  updatedAt: string;
  withdrawnMinor: number;
}

interface LedgerRecord {
  balanceAfterMinor: number;
  bucket: string;
  createdAt: string;
  currency: Currency;
  deltaMinor: number;
  entryType: string;
  id: string;
  referenceId: string;
  referenceType: string;
}

interface WithdrawalFormValues {
  accountHolder: string;
  accountNumber: string;
  amount: string;
  bankName: string;
  countryCode: string;
  currency: Currency;
  routingCode?: string;
}

interface WithdrawalSubmission {
  id: string;
  payoutAccountFingerprint: string;
  withdrawalNo: string;
}

export function TenantFinancePage() {
  const { principal, request } = useAuth();
  const [withdrawalForm] = Form.useForm<WithdrawalFormValues>();
  const watchedCurrency = Form.useWatch('currency', withdrawalForm) ?? 'USD';
  const watchedAmount = Form.useWatch('amount', withdrawalForm) ?? '';
  const amountMinorPreview = previewMinor(watchedAmount, watchedCurrency);
  const [messageApi, messageContext] = message.useMessage();
  const [balances, setBalances] = useState<BalanceRecord[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string>();
  const [ledger, setLedger] = useState<LedgerRecord[]>([]);
  const [ledgerCurrency, setLedgerCurrency] = useState<Currency>();
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string>();
  const [ledgerHasMore, setLedgerHasMore] = useState(false);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [withdrawalLoading, setWithdrawalLoading] = useState(false);
  const [withdrawalError, setWithdrawalError] = useState<string>();
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<WithdrawalRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState<string>();
  const [lastSubmission, setLastSubmission] = useState<WithdrawalSubmission>();
  const balanceSequence = useRef(0);
  const ledgerSequence = useRef(0);
  const withdrawalSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailIdRef = useRef<string | undefined>(undefined);

  const canReadBalance = principal?.permissions.includes('commerce.balance.read') ?? false;
  const canReadWithdrawals = principal?.permissions.includes('commerce.withdrawal.read') ?? false;
  const canSubmit = principal?.permissions.includes('commerce.withdrawal.submit') ?? false;

  const loadBalances = useCallback(async () => {
    if (!canReadBalance) return;
    const sequence = ++balanceSequence.current;
    setBalanceLoading(true);
    setBalanceError(undefined);
    try {
      const result = await request<BalanceRecord[]>(`${API_BASE}/balances`);
      if (sequence === balanceSequence.current) setBalances(result);
    } catch (reason) {
      if (sequence === balanceSequence.current) {
        setBalanceError(errorMessage(reason, '余额加载失败'));
      }
    } finally {
      if (sequence === balanceSequence.current) setBalanceLoading(false);
    }
  }, [canReadBalance, request]);

  const loadLedger = useCallback(async (before?: string, append = false) => {
    if (!canReadBalance) return;
    const sequence = ++ledgerSequence.current;
    setLedgerLoading(true);
    setLedgerError(undefined);
    const parameters = new URLSearchParams({ limit: '50' });
    if (ledgerCurrency) parameters.set('currency', ledgerCurrency);
    if (before) parameters.set('before', before);
    try {
      const result = await request<LedgerRecord[]>(`${API_BASE}/ledger?${parameters}`);
      if (sequence !== ledgerSequence.current) return;
      setLedger((current) => append ? [...current, ...result] : result);
      setLedgerHasMore(result.length === 50);
    } catch (reason) {
      if (sequence === ledgerSequence.current) {
        setLedgerError(errorMessage(reason, '账本加载失败'));
      }
    } finally {
      if (sequence === ledgerSequence.current) setLedgerLoading(false);
    }
  }, [canReadBalance, ledgerCurrency, request]);

  const loadWithdrawals = useCallback(async () => {
    if (!canReadWithdrawals) return;
    const sequence = ++withdrawalSequence.current;
    setWithdrawalLoading(true);
    setWithdrawalError(undefined);
    try {
      const result = await request<WithdrawalRecord[]>(`${API_BASE}/withdrawals?limit=100`);
      if (sequence === withdrawalSequence.current) setWithdrawals(result);
    } catch (reason) {
      if (sequence === withdrawalSequence.current) {
        setWithdrawalError(errorMessage(reason, '提现列表加载失败'));
      }
    } finally {
      if (sequence === withdrawalSequence.current) setWithdrawalLoading(false);
    }
  }, [canReadWithdrawals, request]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  useEffect(() => {
    void loadLedger();
  }, [loadLedger]);

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

  function openDetail(record: WithdrawalRecord): void {
    detailIdRef.current = record.id;
    setDetailId(record.id);
    setDetail(undefined);
    void loadDetail(record.id);
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    detailIdRef.current = undefined;
    setDetailId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(false);
  }

  function openSubmit(): void {
    withdrawalForm.resetFields();
    withdrawalForm.setFieldsValue({ currency: 'USD' });
    setSubmitOpen(true);
  }

  function closeSubmit(): void {
    if (submitting) return;
    setSubmitOpen(false);
    withdrawalForm.resetFields();
  }

  async function submitWithdrawal(values: WithdrawalFormValues): Promise<void> {
    let amountMinor: number;
    try {
      amountMinor = parseMajorAmount(values.amount, values.currency);
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '金额格式不正确');
      return;
    }
    setSubmitting('submit');
    try {
      const result = await request<WithdrawalSubmission>(`${API_BASE}/withdrawals`, {
        body: JSON.stringify({
          amountMinor,
          currency: values.currency,
          payoutAccount: {
            accountHolder: values.accountHolder.trim(),
            accountNumber: values.accountNumber.trim(),
            bankName: values.bankName.trim(),
            countryCode: values.countryCode.trim().toUpperCase(),
            ...(values.routingCode?.trim() ? { routingCode: values.routingCode.trim() } : {}),
          },
        }),
        method: 'POST',
      });
      setLastSubmission(result);
      setSubmitOpen(false);
      withdrawalForm.resetFields();
      messageApi.success('提现申请已提交');
      await Promise.all([loadBalances(), loadLedger(), loadWithdrawals()]);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '提现申请提交失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function cancelWithdrawal(record: WithdrawalRecord): Promise<void> {
    setSubmitting(`cancel:${record.id}`);
    try {
      await request(`${API_BASE}/withdrawals/${encodeURIComponent(record.id)}/cancel`, {
        body: JSON.stringify({ version: record.version }),
        method: 'POST',
      });
      messageApi.success('提现申请已撤回');
      if (detailIdRef.current === record.id) await loadDetail(record.id);
      await Promise.all([loadBalances(), loadLedger(), loadWithdrawals()]);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '撤回失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function canCancel(record: WithdrawalRecord): boolean {
    return canSubmit
      && record.status === 'submitted'
      && record.applicantStaffId === principal?.id;
  }

  const withdrawalColumns = [
    {
      dataIndex: 'withdrawalNo',
      title: '提现单',
      render: (value: string, record: WithdrawalRecord) => (
        <Space direction="vertical" size={0}>
          <Button className="table-link-button" type="link" onClick={() => openDetail(record)}>
            {value}
          </Button>
          <Typography.Text className="secondary-id" type="secondary">{record.id}</Typography.Text>
        </Space>
      ),
    },
    {
      key: 'amount',
      title: '金额',
      render: (_: unknown, record: WithdrawalRecord) => formatMoney(record.amountMinor, record.currency),
    },
    {
      dataIndex: 'status',
      title: '状态',
      render: (status: WithdrawalRecord['status']) => <WithdrawalStatusTag status={status} />,
    },
    { dataIndex: 'payoutAccountFingerprint', title: '收款账户指纹' },
    { dataIndex: 'submittedAt', title: '提交时间', render: formatDateTime, width: 180 },
    {
      key: 'actions',
      title: '操作',
      width: 110,
      render: (_: unknown, record: WithdrawalRecord) => canCancel(record) ? (
        <Popconfirm
          description="撤回后冻结金额将返回可用余额。"
          okButtonProps={{ loading: submitting === `cancel:${record.id}` }}
          onConfirm={() => void cancelWithdrawal(record)}
          title="确认撤回该提现申请？"
        >
          <Button danger disabled={Boolean(submitting)} size="small">撤回</Button>
        </Popconfirm>
      ) : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>余额与提现</Typography.Title>
          <Typography.Text type="secondary">
            余额与账本以服务端数据为准；收款账户提交后仅显示指纹。
          </Typography.Text>
        </div>
        {canSubmit ? <Button disabled={Boolean(submitting)} type="primary" onClick={openSubmit}>申请提现</Button> : null}
      </div>

      {lastSubmission ? (
        <Alert
          closable
          className="page-alert"
          description={`收款账户指纹：${lastSubmission.payoutAccountFingerprint}`}
          message={`提现申请 ${lastSubmission.withdrawalNo} 已提交`}
          onClose={() => setLastSubmission(undefined)}
          showIcon
          type="success"
        />
      ) : null}

      {canReadBalance ? (
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {balanceError ? (
            <Alert
              action={<Button size="small" onClick={() => void loadBalances()}>重试</Button>}
              message={balanceError}
              showIcon
              type="error"
            />
          ) : null}
          <Spin spinning={balanceLoading}>
            {balances.length ? (
              <Row gutter={[16, 16]}>
                {balances.map((balance) => (
                  <Col key={balance.currency} xs={24} xl={12}>
                    <Card title={balance.currency}>
                      <Row gutter={[12, 12]}>
                        <Col span={12}><Statistic title="待结算" value={formatMoney(balance.pendingMinor, balance.currency)} /></Col>
                        <Col span={12}><Statistic title="可用" value={formatMoney(balance.availableMinor, balance.currency)} /></Col>
                        <Col span={12}><Statistic title="冻结" value={formatMoney(balance.frozenMinor, balance.currency)} /></Col>
                        <Col span={12}><Statistic title="已提现" value={formatMoney(balance.withdrawnMinor, balance.currency)} /></Col>
                      </Row>
                      <Typography.Text type="secondary">更新：{formatDateTime(balance.updatedAt)}</Typography.Text>
                    </Card>
                  </Col>
                ))}
              </Row>
            ) : <Empty description="暂无币种余额账户" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </Spin>

          <Card
            extra={(
              <Select<Currency>
                allowClear
                onChange={(value) => {
                  ledgerSequence.current += 1;
                  setLedger([]);
                  setLedgerHasMore(false);
                  setLedgerCurrency(value);
                }}
                options={currencies.map((currency) => ({ label: currency, value: currency }))}
                placeholder="全部币种"
                style={{ width: 130 }}
                value={ledgerCurrency}
              />
            )}
            title="余额账本"
          >
            {ledgerError ? (
              <Alert
                action={<Button size="small" onClick={() => void loadLedger()}>重试</Button>}
                className="page-alert"
                message={ledgerError}
                showIcon
                type="error"
              />
            ) : null}
            <Table<LedgerRecord>
              columns={[
                { dataIndex: 'createdAt', title: '时间', render: formatDateTime, width: 180 },
                { dataIndex: 'currency', title: '币种', width: 80 },
                { dataIndex: 'bucket', title: '账户桶', width: 110 },
                { dataIndex: 'entryType', title: '类型', width: 150 },
                {
                  key: 'delta',
                  title: '变动',
                  render: (_: unknown, record) => (
                    <Typography.Text type={record.deltaMinor < 0 ? 'danger' : 'success'}>
                      {record.deltaMinor > 0 ? '+' : ''}{formatMoney(record.deltaMinor, record.currency)}
                    </Typography.Text>
                  ),
                },
                {
                  key: 'after',
                  title: '变动后余额',
                  render: (_: unknown, record) => formatMoney(record.balanceAfterMinor, record.currency),
                },
                {
                  key: 'reference',
                  title: '关联资源',
                  render: (_: unknown, record) => (
                    <Space direction="vertical" size={0}>
                      <Tag>{record.referenceType}</Tag>
                      <Typography.Text className="secondary-id" copyable type="secondary">
                        {record.referenceId}
                      </Typography.Text>
                    </Space>
                  ),
                },
              ]}
              dataSource={ledger}
              loading={ledgerLoading}
              locale={{ emptyText: <Empty description="暂无账本记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              pagination={false}
              rowKey="id"
              scroll={{ x: 1050 }}
              size="small"
            />
            {ledgerHasMore && ledger.length ? (
              <Button
                block
                loading={ledgerLoading}
                onClick={() => void loadLedger(ledger.at(-1)?.createdAt, true)}
              >
                加载更早记录
              </Button>
            ) : null}
          </Card>
        </Space>
      ) : null}

      {canReadWithdrawals ? (
        <Card className="todo-card" title="提现申请">
          {withdrawalError ? (
            <Alert
              action={<Button size="small" onClick={() => void loadWithdrawals()}>重试</Button>}
              className="page-alert"
              message={withdrawalError}
              showIcon
              type="error"
            />
          ) : null}
          <Table<WithdrawalRecord>
            columns={withdrawalColumns}
            dataSource={withdrawals}
            loading={withdrawalLoading}
            locale={{ emptyText: <Empty description="暂无提现申请" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            pagination={false}
            rowKey="id"
            scroll={{ x: 1050 }}
          />
        </Card>
      ) : null}

      <Drawer
        destroyOnHidden
        extra={detail && canCancel(detail) ? (
          <Popconfirm
            description="只能撤回本人尚未审核的申请。"
            okButtonProps={{ loading: submitting === `cancel:${detail.id}` }}
            onConfirm={() => void cancelWithdrawal(detail)}
            title="确认撤回？"
          >
            <Button danger disabled={Boolean(submitting)}>撤回申请</Button>
          </Popconfirm>
        ) : null}
        onClose={closeDetail}
        open={Boolean(detailId)}
        title="提现详情"
        width={760}
      >
        {detailLoading ? <Spin /> : detailError ? (
          <Alert
            action={<Button size="small" onClick={() => detailId && void loadDetail(detailId)}>重试</Button>}
            message={detailError}
            showIcon
            type="error"
          />
        ) : detail ? <WithdrawalDetail withdrawal={detail} /> : null}
      </Drawer>

      <Modal
        cancelText="取消"
        destroyOnHidden
        okText="提交申请"
        confirmLoading={submitting === 'submit'}
        onCancel={closeSubmit}
        onOk={() => withdrawalForm.submit()}
        open={submitOpen}
        title="申请提现"
        width={720}
      >
        <Alert
          className="page-alert"
          description="收款账户将加密保存，提交成功后代理商后台只显示指纹，不回显完整账号。"
          message="请仔细核对收款信息"
          showIcon
          type="warning"
        />
        <Form<WithdrawalFormValues>
          form={withdrawalForm}
          layout="vertical"
          onFinish={(values) => void submitWithdrawal(values)}
          requiredMark={false}
        >
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="币种" name="currency" rules={[{ required: true }]}>
                <Select options={currencies.map((currency) => ({ label: currency, value: currency }))} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item
                extra={amountMinorPreview === undefined
                  ? `当前币种支持 ${fractionDigits(watchedCurrency)} 位小数，将精确转换为 minor 提交`
                  : `服务端将收到 ${amountMinorPreview} minor`}
                label="提现金额"
                name="amount"
                rules={[{ required: true, message: '请输入提现金额', whitespace: true }]}
              >
                <Input inputMode="decimal" maxLength={32} placeholder={fractionDigits(watchedCurrency) ? '100.00' : '100'} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="收款人 / 户名" name="accountHolder" rules={[{ required: true, min: 2, max: 200, whitespace: true }]}>
                <Input autoComplete="off" maxLength={200} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="银行名称" name="bankName" rules={[{ required: true, min: 2, max: 200, whitespace: true }]}>
                <Input autoComplete="off" maxLength={200} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="收款账号" name="accountNumber" rules={[{ required: true, min: 4, max: 64, whitespace: true }]}>
            <Input.Password autoComplete="new-password" maxLength={64} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item
                label="国家/地区代码"
                name="countryCode"
                rules={[
                  { required: true, message: '请输入两位代码' },
                  { pattern: /^[A-Za-z]{2}$/, message: '请输入两位英文代码' },
                ]}
              >
                <Input autoComplete="off" maxLength={2} placeholder="US" />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item label="Routing Code（可选）" name="routingCode" rules={[{ min: 2, max: 64 }]}>
                <Input autoComplete="off" maxLength={64} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </>
  );
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function previewMinor(value: string, currency: Currency): number | undefined {
  if (!value.trim()) return undefined;
  try {
    return parseMajorAmount(value, currency);
  } catch {
    return undefined;
  }
}
