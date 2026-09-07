import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { formatDateTime, formatMoney, type Currency } from './finance-ui';
import { formatBpsAsPercent, parsePercentToBps } from './referral-ui';

type OrderType = 'drama' | 'episode' | 'membership' | 'points_topup';

interface ReferralConfig {
  applicableOrderTypes: OrderType[];
  commissionBps: number;
  enabled: boolean;
  settlementDays: number;
  version: number;
}

interface ReferralConfigForm {
  applicableOrderTypes: OrderType[];
  commissionPercent: string;
  enabled: boolean;
  settlementDays: number;
}

interface CommissionRecord {
  commissionBps: number;
  commissionMinor: number;
  createdAt: string;
  currency: Currency;
  eligibleAt: string;
  id: string;
  inviteeAccountId: string;
  inviterAccountId: string;
  orderId: string;
  orderTotalMinor: number;
  orderType: OrderType;
  status: 'available' | 'pending' | 'reversed';
}

interface CommissionResponse {
  items: CommissionRecord[];
  page: number;
  pageSize: number;
}

const API_BASE = '/api/v1/tenant/referrals';
const orderTypeOptions = [
  { label: '会员', value: 'membership' },
  { label: '整剧购买', value: 'drama' },
  { label: '单集购买', value: 'episode' },
  { label: '金币充值', value: 'points_topup' },
];
const emptyCommissions: CommissionResponse = { items: [], page: 1, pageSize: 20 };

export function TenantReferralPage() {
  const { principal, request } = useAuth();
  const [form] = Form.useForm<ReferralConfigForm>();
  const [messageApi, messageContext] = message.useMessage();
  const [config, setConfig] = useState<ReferralConfig>();
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string>();
  const [commissions, setCommissions] = useState(emptyCommissions);
  const [commissionLoading, setCommissionLoading] = useState(true);
  const [commissionError, setCommissionError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const configSequence = useRef(0);
  const commissionSequence = useRef(0);
  const canManage = principal?.permissions.includes('commerce.referral.manage') ?? false;

  const loadConfig = useCallback(async () => {
    const sequence = ++configSequence.current;
    setConfigLoading(true);
    setConfigError(undefined);
    try {
      const result = await request<ReferralConfig>(`${API_BASE}/config`);
      if (sequence !== configSequence.current) return;
      setConfig(result);
      form.setFieldsValue({
        applicableOrderTypes: result.applicableOrderTypes,
        commissionPercent: formatBpsAsPercent(result.commissionBps),
        enabled: result.enabled,
        settlementDays: result.settlementDays,
      });
    } catch (reason) {
      if (sequence === configSequence.current) {
        setConfigError(errorMessage(reason, '分销配置加载失败'));
      }
    } finally {
      if (sequence === configSequence.current) setConfigLoading(false);
    }
  }, [form, request]);

  const loadCommissions = useCallback(async (
    page = 1,
    pageSize = commissions.pageSize,
  ) => {
    const sequence = ++commissionSequence.current;
    setCommissionLoading(true);
    setCommissionError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) query.set('status', status);
    try {
      const result = await request<CommissionResponse>(`${API_BASE}/commissions?${query}`);
      if (sequence === commissionSequence.current) setCommissions(result);
    } catch (reason) {
      if (sequence === commissionSequence.current) {
        setCommissionError(errorMessage(reason, '佣金应付账加载失败'));
      }
    } finally {
      if (sequence === commissionSequence.current) setCommissionLoading(false);
    }
  }, [commissions.pageSize, request, status]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { void loadCommissions(1); }, [loadCommissions]);

  async function saveConfig(values: ReferralConfigForm): Promise<void> {
    if (!config) return;
    let commissionBps: number;
    try {
      commissionBps = parsePercentToBps(values.commissionPercent);
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '佣金比例无效');
      return;
    }
    if (values.enabled && (commissionBps === 0 || !values.applicableOrderTypes.length)) {
      messageApi.error('启用分销时必须配置大于 0 的比例和至少一种商品类型');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await request<ReferralConfig>(`${API_BASE}/config`, {
        body: JSON.stringify({
          applicableOrderTypes: values.applicableOrderTypes,
          commissionBps,
          enabled: values.enabled,
          settlementDays: values.settlementDays,
          version: config.version,
        }),
        method: 'PUT',
      });
      setConfig(updated);
      form.setFieldValue('commissionPercent', formatBpsAsPercent(updated.commissionBps));
      messageApi.success('一级分销配置已保存');
    } catch (reason) {
      messageApi.error(errorMessage(reason, '分销配置保存失败'));
      if (reason instanceof ApiError && reason.status === 409) await loadConfig();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>一级分销</Typography.Title>
          <Typography.Text type="secondary">
            只支持一级邀请关系；佣金列表是代理商应付账，不提供提现或打款操作。
          </Typography.Text>
        </div>
      </div>

      {configError ? (
        <Alert
          action={<Button size="small" onClick={() => void loadConfig()}>重试</Button>}
          className="page-alert"
          message={configError}
          showIcon
          type="error"
        />
      ) : null}
      <Card loading={configLoading} title="分销规则">
        <Form<ReferralConfigForm>
          name="tenantreferralpage-1" disabled={!canManage || submitting}
          form={form}
          layout="vertical"
          onFinish={(values) => void saveConfig(values)}
          requiredMark={false}
        >
          <Row gutter={16}>
            <Col md={6} xs={24}>
              <Form.Item label="启用一级分销" name="enabled" valuePropName="checked">
                <Switch checkedChildren="开启" unCheckedChildren="关闭" />
              </Form.Item>
            </Col>
            <Col md={8} xs={24}>
              <Form.Item
                extra="最多保留两位小数。"
                label="佣金比例（%）"
                name="commissionPercent"
                rules={[{ required: true }]}
              >
                <Input inputMode="decimal" placeholder="5.00" suffix="%" />
              </Form.Item>
            </Col>
            <Col md={6} xs={24}>
              <Form.Item label="结算等待天数" name="settlementDays" rules={[{ required: true }]}>
                <InputNumber max={90} min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="适用商品类型" name="applicableOrderTypes">
                <Checkbox.Group options={orderTypeOptions} />
              </Form.Item>
            </Col>
          </Row>
          {canManage ? <Button htmlType="submit" loading={submitting} type="primary">保存规则</Button> : (
            <Typography.Text type="secondary">当前账号为只读权限。</Typography.Text>
          )}
        </Form>
      </Card>

      <Card className="todo-card" title="佣金应付账">
        <Alert
          className="page-alert"
          message="查看待结算、可结算和已冲正的邀请佣金。"
          showIcon
          type="info"
        />
        <div className="tenant-content-toolbar">
          <Select
            allowClear
            options={[
              { label: '待结算', value: 'pending' },
              { label: '可支付', value: 'available' },
              { label: '已冲正', value: 'reversed' },
            ]}
            placeholder="全部状态"
            style={{ width: 140 }}
            value={status}
            onChange={(value) => {
              commissionSequence.current += 1;
              setCommissions(emptyCommissions);
              setStatus(value);
            }}
          />
          <Button loading={commissionLoading} onClick={() => void loadCommissions(commissions.page, commissions.pageSize)}>刷新</Button>
        </div>
        {commissionError ? (
          <Alert
            action={<Button size="small" onClick={() => void loadCommissions(commissions.page, commissions.pageSize)}>重试</Button>}
            className="page-alert"
            message={commissionError}
            showIcon
            type="error"
          />
        ) : null}
        <Table<CommissionRecord>
          dataSource={commissions.items}
          loading={commissionLoading}
          locale={{ emptyText: <Empty description="暂无佣金应付记录" /> }}
          pagination={{
            current: commissions.page,
            onChange: (page, pageSize) => void loadCommissions(page, pageSize),
            pageSize: commissions.pageSize,
            showSizeChanger: true,
            total: (commissions.page - 1) * commissions.pageSize + commissions.items.length + (commissions.items.length === commissions.pageSize ? 1 : 0),
          }}
          rowKey="id"
          scroll={{ x: 1450 }}
          columns={[
            {
              dataIndex: 'orderId',
              title: '订单',
              render: (value: string, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text copyable>{value}</Typography.Text>
                  <Typography.Text type="secondary">{orderTypeLabel(record.orderType)}</Typography.Text>
                </Space>
              ),
            },
            { dataIndex: 'inviterAccountId', title: '邀请人', render: (value) => <Typography.Text copyable>{value}</Typography.Text> },
            { dataIndex: 'inviteeAccountId', title: '被邀请人', render: (value) => <Typography.Text copyable>{value}</Typography.Text> },
            { key: 'orderTotal', title: '订单金额', render: (_, record) => formatMoney(record.orderTotalMinor, record.currency) },
            { key: 'rate', title: '比例', width: 90, render: (_, record) => `${formatBpsAsPercent(record.commissionBps)}%` },
            { key: 'commission', title: '应付佣金', render: (_, record) => <Typography.Text strong>{formatMoney(record.commissionMinor, record.currency)}</Typography.Text> },
            { dataIndex: 'status', title: '状态', width: 100, render: (value) => <CommissionStatus status={value} /> },
            { dataIndex: 'eligibleAt', title: '可结算时间', width: 180, render: formatDateTime },
            { dataIndex: 'createdAt', title: '记录时间', width: 180, render: formatDateTime },
          ]}
        />
      </Card>
    </>
  );
}

function CommissionStatus({ status }: { status: CommissionRecord['status'] }) {
  const option = ({
    available: { color: 'green', text: '可支付' },
    pending: { color: 'orange', text: '待结算' },
    reversed: { color: undefined, text: '已冲正' },
  } as const)[status];
  return <Tag color={option.color}>{option.text}</Tag>;
}

function orderTypeLabel(value: OrderType): string {
  return ({ drama: '整剧购买', episode: '单集购买', membership: '会员', points_topup: '金币充值' } as const)[value];
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) {
    return reason.status === 409 ? `${reason.message}，已刷新最新版本` : reason.message;
  }
  return fallback;
}
