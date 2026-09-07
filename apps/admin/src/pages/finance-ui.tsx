import { Descriptions, Empty, Space, Table, Tag, Typography } from 'antd';

export const currencies = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;
export type Currency = (typeof currencies)[number];

export type WithdrawalStatus =
  | 'submitted'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'paying'
  | 'paid'
  | 'failed';

export interface WithdrawalAction {
  action: string;
  actorId: string;
  actorType: string;
  bankReference?: string;
  createdAt: string;
  fromStatus?: string;
  proofMediaAssetId?: string;
  reason?: string;
  toStatus: string;
}

export interface WithdrawalRecord {
  actions?: WithdrawalAction[];
  amountMinor: number;
  applicantStaffId: string;
  bankReference?: string;
  cancelledAt?: string;
  completedAt?: string;
  createdAt: string;
  currency: Currency;
  feeMinor: number;
  id: string;
  payoutAccountFingerprint: string;
  proofMediaAssetId?: string;
  reviewReason?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  status: WithdrawalStatus;
  submittedAt: string;
  tenantId: string;
  version: number;
  withdrawalNo: string;
}

const statusLabels: Record<WithdrawalStatus, { color?: string; label: string }> = {
  approved: { color: 'blue', label: '已批准' },
  cancelled: { label: '已撤回' },
  failed: { color: 'red', label: '打款失败' },
  paid: { color: 'green', label: '已打款' },
  paying: { color: 'gold', label: '打款中' },
  rejected: { color: 'red', label: '已驳回' },
  reviewing: { color: 'gold', label: '审核中' },
  submitted: { color: 'orange', label: '已提交' },
};

export const withdrawalStatusOptions = Object.entries(statusLabels).map(([value, option]) => ({
  label: option.label,
  value: value as WithdrawalStatus,
}));

export function WithdrawalStatusTag({ status }: { status: WithdrawalStatus }) {
  const option = statusLabels[status] ?? { label: status };
  return <Tag color={option.color}>{option.label}</Tag>;
}

export function WithdrawalDetail({ withdrawal }: { withdrawal: WithdrawalRecord }) {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="提现单号">{withdrawal.withdrawalNo}</Descriptions.Item>
        <Descriptions.Item label="代理商 ID">
          <Typography.Text copyable>{withdrawal.tenantId}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="申请人 ID">
          <Typography.Text copyable>{withdrawal.applicantStaffId}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="金额">
          {formatMoney(withdrawal.amountMinor, withdrawal.currency)}
        </Descriptions.Item>
        <Descriptions.Item label="手续费">
          {formatMoney(withdrawal.feeMinor, withdrawal.currency)}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <WithdrawalStatusTag status={withdrawal.status} />
        </Descriptions.Item>
        <Descriptions.Item label="收款账户指纹">
          {withdrawal.payoutAccountFingerprint}
        </Descriptions.Item>
        <Descriptions.Item label="审核原因">{withdrawal.reviewReason || '—'}</Descriptions.Item>
        <Descriptions.Item label="银行参考号">{withdrawal.bankReference || '—'}</Descriptions.Item>
        <Descriptions.Item label="打款凭证 Media ID">
          {withdrawal.proofMediaAssetId ? (
            <Typography.Text copyable>{withdrawal.proofMediaAssetId}</Typography.Text>
          ) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="提交时间">{formatDateTime(withdrawal.submittedAt)}</Descriptions.Item>
        <Descriptions.Item label="完成时间">
          {withdrawal.completedAt ? formatDateTime(withdrawal.completedAt) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="版本">{withdrawal.version}</Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Title level={5}>操作记录</Typography.Title>
        <Table<WithdrawalAction>
          columns={[
            { dataIndex: 'action', title: '操作', width: 130 },
            {
              key: 'transition',
              title: '状态变更',
              render: (_, action) => `${action.fromStatus ?? '—'} → ${action.toStatus}`,
            },
            { dataIndex: 'reason', title: '原因', render: (value?: string) => value || '—' },
            { dataIndex: 'createdAt', title: '时间', render: formatDateTime, width: 180 },
          ]}
          dataSource={withdrawal.actions ?? []}
          locale={{ emptyText: <Empty description="暂无操作记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          pagination={false}
          rowKey={(action) => `${action.createdAt}:${action.action}:${action.actorId}`}
          scroll={{ x: 700 }}
          size="small"
        />
      </div>
    </Space>
  );
}

export function formatMoney(amountMinor: number, currency: Currency): string {
  const digits = fractionDigits(currency);
  try {
    return new Intl.NumberFormat('zh-CN', {
      currency,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
      style: 'currency',
    }).format(amountMinor / (10 ** digits));
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

export function parseMajorAmount(value: string, currency: Currency): number {
  const digits = fractionDigits(currency);
  const normalized = value.trim();
  const pattern = digits === 0
    ? /^(0|[1-9]\d*)$/
    : /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
  const match = pattern.exec(normalized);
  if (!match) {
    throw new Error(digits === 0 ? '该币种只能输入整数金额' : '金额最多保留 2 位小数');
  }
  const factor = 10n ** BigInt(digits);
  const fraction = (match[2] ?? '').padEnd(digits, '0');
  const minor = BigInt(match[1] ?? '0') * factor + BigInt(fraction || '0');
  if (minor < 1n || minor > 9_000_000_000_000_000n) {
    throw new Error('金额必须大于 0 且不能超过系统上限');
  }
  return Number(minor);
}

export function fractionDigits(currency: Currency): number {
  return currency === 'JPY' || currency === 'KRW' ? 0 : 2;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
const ledgerLabels: Record<string, string> = {
  pending: '待结算', available: '可用余额', frozen: '冻结金额', withdrawn: '已提现',
  payment_pending: '收款待结算', settlement_available: '结算入账', freeze: '提现冻结',
  unfreeze: '解除冻结', withdrawal: '提现', refund: '退款', adjustment: '余额调整',
  payment_transaction: '支付流水', merchant_settlement: '结算记录', settlement: '结算记录',
  withdrawal_request: '提现申请', refund_transaction: '退款流水',
};
export function ledgerLabel(value: string): string { return ledgerLabels[value] ?? '其他'; }
