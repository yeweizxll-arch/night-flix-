import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  canManageConfig,
  configMatchesMode,
  isVersionConflict,
  stripeActionPath,
  stripeCreatePath,
  stripeSummary,
  type CollectionMode,
  type PaymentConfigRecord,
  type StripeMode,
} from './payment-settings-ui';

interface TenantPaymentConfigResponse {
  configs: PaymentConfigRecord[];
  routing: TenantPaymentRouting | null;
}

interface TenantPaymentRouting {
  collectionMode: CollectionMode;
  paymentConfigId: string;
  version: number;
}

interface FakeConfigForm {
  label: string;
}

interface StripeConfigForm {
  accountId: string;
  confirmLive?: boolean;
  label: string;
  mode: StripeMode;
  secretKey: string;
  webhookSecret: string;
}

interface StripeRotateForm {
  secretKey: string;
  webhookSecret: string;
}

interface PaymentSettingsPageProps {
  apiBase: string;
  description: string;
  managePermission: string;
  scope: 'platform' | 'tenant';
  title: string;
}

const FAKE_PAYMENT_ENABLED =
  import.meta.env.VITE_ENABLE_FAKE_PAYMENT === 'true' && !import.meta.env.PROD;

export function PaymentSettingsPage({
  apiBase,
  description,
  managePermission,
  scope,
  title,
}: PaymentSettingsPageProps) {
  const { principal, request } = useAuth();
  const [fakeForm] = Form.useForm<FakeConfigForm>();
  const [stripeForm] = Form.useForm<StripeConfigForm>();
  const [rotateForm] = Form.useForm<StripeRotateForm>();
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const [configs, setConfigs] = useState<PaymentConfigRecord[]>([]);
  const [routing, setRouting] = useState<TenantPaymentRouting | null>(null);
  const [collectionMode, setCollectionMode] = useState<CollectionMode>('platform_collect');
  const [paymentConfigId, setPaymentConfigId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState<string>();
  const [fakeOpen, setFakeOpen] = useState(false);
  const [stripeOpen, setStripeOpen] = useState(false);
  const [rotateConfig, setRotateConfig] = useState<PaymentConfigRecord>();
  const loadSequence = useRef(0);

  const canManage = principal?.permissions.includes(managePermission) ?? false;

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(undefined);
    try {
      if (scope === 'platform') {
        const result = await request<PaymentConfigRecord[]>(apiBase);
        if (sequence === loadSequence.current) setConfigs(result);
        return;
      }
      const result = await request<TenantPaymentConfigResponse>(`${apiBase}/configs`);
      if (sequence !== loadSequence.current) return;
      setConfigs(result.configs);
      setRouting(result.routing);
      const nextMode = result.routing?.collectionMode ?? 'platform_collect';
      setCollectionMode(nextMode);
      setPaymentConfigId(
        result.routing?.paymentConfigId
        ?? firstConfigForMode(result.configs, nextMode)?.id,
      );
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(errorMessage(reason, '支付配置加载失败'));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [apiBase, request, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const compatibleConfigs = useMemo(
    () => configs.filter((config) => configMatchesMode(config, collectionMode)),
    [collectionMode, configs],
  );
  const routingConfigAvailable = !routing
    || configs.some((config) => config.id === routing.paymentConfigId
      && configMatchesMode(config, routing.collectionMode));

  function changeCollectionMode(nextMode: CollectionMode): void {
    setCollectionMode(nextMode);
    const selected = configs.find((config) => config.id === paymentConfigId);
    if (!selected || !configMatchesMode(selected, nextMode)) {
      setPaymentConfigId(firstConfigForMode(configs, nextMode)?.id);
    }
  }

  async function saveRouting(): Promise<void> {
    if (scope !== 'tenant' || !paymentConfigId) return;
    setSubmitting('routing');
    try {
      await request<TenantPaymentRouting>(`${apiBase}/routing`, {
        body: JSON.stringify({ collectionMode, paymentConfigId }),
        method: 'PUT',
      });
      messageApi.success('支付收款路由已更新');
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '支付收款路由更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function createFake(values: FakeConfigForm): Promise<void> {
    if (!FAKE_PAYMENT_ENABLED) return;
    setSubmitting('fake');
    try {
      const path = scope === 'platform' ? `${apiBase}/fake` : `${apiBase}/configs/fake`;
      await request(path, {
        body: JSON.stringify({ label: values.label.trim(), providerCode: 'fake' }),
        method: 'POST',
      });
      messageApi.success('Fake 支付配置已创建');
      setFakeOpen(false);
      fakeForm.resetFields();
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, 'Fake 支付配置创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function createStripe(values: StripeConfigForm): Promise<void> {
    setSubmitting('stripe-create');
    try {
      await request(stripeCreatePath(apiBase, scope), {
        body: JSON.stringify({
          accountId: values.accountId.trim(),
          label: values.label.trim(),
          mode: values.mode,
          secretKey: values.secretKey,
          webhookSecret: values.webhookSecret,
        }),
        method: 'POST',
      });
      messageApi.success('Stripe 配置已保存。当前仍为停用，请先执行真实连接测试。');
      closeStripeModal();
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, 'Stripe 配置保存失败'));
      if (isVersionConflict(reason)) await load();
    } finally {
      setSubmitting(undefined);
    }
  }

  async function rotateStripe(values: StripeRotateForm): Promise<void> {
    const config = rotateConfig;
    const summary = config ? stripeSummary(config) : undefined;
    if (!config || !summary) return;
    setSubmitting(`rotate:${config.id}`);
    try {
      await request(stripeActionPath(apiBase, scope, config.id, 'credentials'), {
        body: JSON.stringify({
          accountId: summary.accountId,
          expectedVersion: config.version,
          mode: summary.mode,
          secretKey: values.secretKey,
          webhookSecret: values.webhookSecret,
        }),
        method: 'PUT',
      });
      messageApi.success('凭据已轮换，配置已停用；必须重新测试通过后才能启用。');
      closeRotateModal();
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, 'Stripe 凭据轮换失败'));
      if (isVersionConflict(reason)) await load();
    } finally {
      setSubmitting(undefined);
    }
  }

  async function stripeAction(
    config: PaymentConfigRecord,
    action: 'disable' | 'enable' | 'test',
  ): Promise<void> {
    setSubmitting(`${action}:${config.id}`);
    try {
      await request(stripeActionPath(apiBase, scope, config.id, action), {
        body: JSON.stringify({ expectedVersion: config.version }),
        method: 'POST',
      });
      messageApi.success(action === 'test'
        ? 'Stripe 连接测试已完成，请以刷新后的测试状态为准。'
        : action === 'enable' ? 'Stripe 配置已启用' : 'Stripe 配置已停用');
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, action === 'test'
        ? 'Stripe 连接测试失败'
        : 'Stripe 配置状态更新失败'));
      if (isVersionConflict(reason)) {
        messageApi.warning('配置版本已变化，已刷新最新状态，请重新操作。');
        await load();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function closeStripeModal(): void {
    setStripeOpen(false);
    stripeForm.resetFields();
  }

  function closeRotateModal(): void {
    setRotateConfig(undefined);
    rotateForm.resetFields();
  }

  function confirmStripeStatus(
    config: PaymentConfigRecord,
    action: 'disable' | 'enable',
  ): void {
    const summary = stripeSummary(config);
    modalApi.confirm({
      cancelText: '取消',
      content: action === 'enable' && summary?.mode === 'live'
        ? '这是 LIVE 生产收款配置。启用后真实客户订单可能进入该 Stripe 账号，请确认账户和 Webhook 已完成真实测试。'
        : action === 'enable'
          ? '启用后该配置可被收款路由选择。'
          : '停用后该配置不能创建新的支付，但历史 Stripe Webhook 仍由服务端安全处理。',
      okButtonProps: action === 'enable' && summary?.mode === 'live'
        ? { danger: true }
        : undefined,
      okText: action === 'enable' ? '确认启用' : '确认停用',
      onOk: () => stripeAction(config, action),
      title: action === 'enable' ? '启用 Stripe 配置？' : '停用 Stripe 配置？',
    });
  }

  const columns = useMemo(() => [
    {
      dataIndex: 'label',
      title: '配置',
      render: (label: string, config: PaymentConfigRecord) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            <Typography.Text strong>{label}</Typography.Text>
            {config.provider === 'fake' ? <Tag color="red">Fake·本地测试</Tag> : null}
            {scope === 'tenant' ? (
              <Tag color={config.ownerType === 'platform' ? 'blue' : 'purple'}>
                {config.ownerType === 'platform' ? '平台公共' : '商家独立'}
              </Tag>
            ) : null}
          </Space>
          <Typography.Text className="secondary-id" copyable type="secondary">
            {config.id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      dataIndex: 'provider',
      title: '渠道',
      width: 140,
      render: (provider: string, config: PaymentConfigRecord) => (
        <Space direction="vertical" size={2}>
          <Typography.Text code>{provider}</Typography.Text>
          {stripeSummary(config)?.mode === 'live'
            ? <Tag color="red">LIVE·真实收款</Tag>
            : stripeSummary(config)?.mode === 'test'
              ? <Tag color="gold">TEST·测试模式</Tag>
              : null}
        </Space>
      ),
    },
    {
      dataIndex: 'status',
      title: '状态',
      width: 100,
      render: (status: PaymentConfigRecord['status']) => status === 'active'
        ? <Tag color="green">启用</Tag>
        : <Tag>停用</Tag>,
    },
    {
      key: 'stripeAccount',
      title: 'Stripe 账户 / 测试',
      render: (_: unknown, config: PaymentConfigRecord) => {
        const summary = stripeSummary(config);
        if (!summary) return <Typography.Text type="secondary">非 Stripe 配置</Typography.Text>;
        return (
          <Space direction="vertical" size={2}>
            <Typography.Text code copyable>{summary.accountId}</Typography.Text>
            <Tag color={summary.testStatus === 'passed'
              ? 'green'
              : summary.testStatus === 'failed' ? 'red' : 'default'}>
              {summary.testStatus === 'passed'
                ? '真实测试已通过'
                : summary.testStatus === 'failed' ? '真实测试失败' : '尚未测试'}
            </Tag>
            <Typography.Text
              copyable
              ellipsis
              style={{ maxWidth: 330 }}
              type="secondary"
            >
              {`Webhook：/api/v1/payments/webhooks/${config.id}/stripe`}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      dataIndex: 'version',
      title: '版本',
      width: 80,
    },
    {
      fixed: 'right' as const,
      key: 'actions',
      title: '操作',
      width: 250,
      render: (_: unknown, config: PaymentConfigRecord) => {
        const summary = stripeSummary(config);
        if (!canManage || !summary || !canManageConfig(config, scope)) {
          return <Typography.Text type="secondary">只读</Typography.Text>;
        }
        return (
          <Space size={4} wrap>
            <Button
              disabled={config.status === 'active'}
              loading={submitting === `test:${config.id}`}
              onClick={() => void stripeAction(config, 'test')}
              size="small"
            >
              连接测试
            </Button>
            <Button
              loading={submitting === `rotate:${config.id}`}
              onClick={() => {
                rotateForm.resetFields();
                setRotateConfig(config);
              }}
              size="small"
            >
              轮换凭据
            </Button>
            {config.status === 'active' ? (
              <Button
                danger
                loading={submitting === `disable:${config.id}`}
                onClick={() => confirmStripeStatus(config, 'disable')}
                size="small"
              >
                停用
              </Button>
            ) : (
              <Button
                disabled={summary.testStatus !== 'passed'}
                loading={submitting === `enable:${config.id}`}
                onClick={() => confirmStripeStatus(config, 'enable')}
                size="small"
                type={summary.mode === 'live' ? 'default' : 'primary'}
                danger={summary.mode === 'live'}
              >
                启用
              </Button>
            )}
          </Space>
        );
      },
    },
  ], [canManage, confirmStripeStatus, rotateForm, scope, stripeAction, submitting]);

  return (
    <>
      {messageContext}
      {modalContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </div>
        <Space wrap>
          <Button loading={loading} onClick={() => void load()}>刷新</Button>
          {canManage ? (
            <Button
              onClick={() => {
                stripeForm.resetFields();
                stripeForm.setFieldsValue({ mode: 'test' });
                setStripeOpen(true);
              }}
              type="primary"
            >
              新建 Stripe Hosted Checkout
            </Button>
          ) : null}
          {FAKE_PAYMENT_ENABLED && canManage ? (
            <Button danger onClick={() => setFakeOpen(true)}>
              创建 Fake 配置（本地测试）
            </Button>
          ) : null}
        </Space>
      </div>

      {FAKE_PAYMENT_ENABLED ? (
        <Alert
          className="page-alert"
          description="Fake 渠道仅用于本地联调，不得用于真实收款；生产构建不会显示创建入口。"
          message="本地测试功能已显式开启"
          showIcon
          type="warning"
        />
      ) : null}

      <Alert
        className="page-alert"
        description="TEST 和 LIVE 配置完全独立，不会自动回退或切换。密钥只能写入，后台永不回显；新建或轮换后会强制停用。连接测试验证当前账户凭据，不代表 Webhook 已在 Stripe Dashboard 配置；启用前还必须使用列表中的回调路径配置对应模式的 Webhook。"
        message="Stripe 配置安全边界"
        showIcon
        type="info"
      />

      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
          className="page-alert"
          closable
          message={error}
          onClose={() => setError(undefined)}
          showIcon
          type="error"
        />
      ) : null}

      {!loading && configs.length > 0 && configs.every((config) => config.provider === 'fake') ? (
        <Alert
          className="page-alert"
          description="当前没有已安装的真实支付渠道，Fake 配置只能用于本地联调。"
          message="尚未配置真实收款渠道"
          showIcon
          type="warning"
        />
      ) : null}

      {scope === 'tenant' ? (
        <Card className="todo-card" title="收款路由">
          {!routingConfigAvailable ? (
            <Alert
              className="page-alert"
              message="当前路由指向的支付配置已不可用，请重新选择。"
              showIcon
              type="warning"
            />
          ) : null}
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Radio.Group
              disabled={!canManage}
              onChange={(event) => changeCollectionMode(event.target.value as CollectionMode)}
              value={collectionMode}
            >
              <Radio.Button value="platform_collect">平台公共代收</Radio.Button>
              <Radio.Button value="tenant_direct">商家独立直收</Radio.Button>
            </Radio.Group>
            <Select
              disabled={!canManage}
              notFoundContent="该收款模式暂无可用配置"
              onChange={setPaymentConfigId}
              options={compatibleConfigs.map((config) => ({
                label: `${config.label} · ${config.provider}${stripeSummary(config)?.mode
                  ? ` · ${stripeSummary(config)?.mode.toUpperCase()}` : ''}`,
                value: config.id,
              }))}
              placeholder="选择支付配置"
              showSearch
              optionFilterProp="label"
              value={paymentConfigId}
            />
            {canManage ? (
              <Button
                disabled={!paymentConfigId}
                loading={submitting === 'routing'}
                onClick={() => void saveRouting()}
                type="primary"
              >
                保存收款路由
              </Button>
            ) : (
              <Typography.Text type="secondary">当前账号仅可查看收款路由。</Typography.Text>
            )}
          </Space>
        </Card>
      ) : null}

      <Table<PaymentConfigRecord>
        columns={columns}
        dataSource={configs}
        loading={loading}
        locale={{
          emptyText: (
            <Empty
              description={scope === 'platform'
                ? '尚未安装并配置真实支付渠道'
                : '暂无可用的公共或商家独立支付配置'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ),
        }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 1120 }}
      />

      <Modal
        cancelText="取消"
        destroyOnHidden
        confirmLoading={submitting === 'stripe-create'}
        okText="保存为停用配置"
        onCancel={() => {
          if (!submitting) closeStripeModal();
        }}
        onOk={() => stripeForm.submit()}
        open={stripeOpen}
        title="新建 Stripe Hosted Checkout 配置"
      >
        <Alert
          className="page-alert"
          description="请在 Stripe Dashboard 中创建对应模式的限制密钥和 Webhook signing secret。TEST 与 LIVE 凭据不能混用。"
          message="凭据仅在本次提交中使用，关闭窗口即清空"
          showIcon
          type="warning"
        />
        <Form<StripeConfigForm>
          form={stripeForm}
          initialValues={{ mode: 'test' }}
          layout="vertical"
          onFinish={(values) => void createStripe(values)}
          preserve={false}
          requiredMark={false}
        >
          <Form.Item label="配置名称" name="label" rules={[
            { required: true, message: '请输入配置名称', whitespace: true },
            { max: 100, message: '最多 100 字' },
          ]}>
            <Input maxLength={100} placeholder="例如：Stripe 日本站生产" />
          </Form.Item>
          <Form.Item label="模式" name="mode" rules={[{ required: true }]}>
            <Radio.Group buttonStyle="solid">
              <Radio.Button value="test">TEST 测试</Radio.Button>
              <Radio.Button value="live">LIVE 真实收款</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.mode !== after.mode}>
            {({ getFieldValue }) => getFieldValue('mode') === 'live' ? (
              <>
                <Alert
                  className="page-alert"
                  message="LIVE 模式会接收真实资金；保存后仍是停用，不会自动上线。"
                  showIcon
                  type="error"
                />
                <Form.Item
                  name="confirmLive"
                  valuePropName="checked"
                  rules={[{
                    validator: (_, value) => value
                      ? Promise.resolve()
                      : Promise.reject(new Error('请确认 LIVE 模式')),
                  }]}
                >
                  <Checkbox>我确认这是 LIVE 生产账户，并将在启用前完成真实测试</Checkbox>
                </Form.Item>
              </>
            ) : null}
          </Form.Item>
          <Form.Item
            label="Stripe Account ID"
            name="accountId"
            rules={[
              { required: true, message: '请输入 Stripe Account ID' },
              { pattern: /^acct_[A-Za-z0-9]{8,64}$/, message: '格式应为 acct_ 开头' },
            ]}
          >
            <Input autoComplete="off" maxLength={69} placeholder="acct_…" />
          </Form.Item>
          <Form.Item label="Stripe Secret Key" name="secretKey" rules={[
            { required: true, message: '请输入 Secret Key' },
            { min: 16, max: 4096, message: '凭据长度无效' },
          ]}>
            <Input.Password autoComplete="new-password" maxLength={4096} visibilityToggle={false} />
          </Form.Item>
          <Form.Item label="Webhook Signing Secret" name="webhookSecret" rules={[
            { required: true, message: '请输入 Webhook Signing Secret' },
            { min: 16, max: 4096, message: '凭据长度无效' },
          ]}>
            <Input.Password autoComplete="new-password" maxLength={4096} visibilityToggle={false} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        cancelText="取消"
        destroyOnHidden
        confirmLoading={Boolean(rotateConfig && submitting === `rotate:${rotateConfig.id}`)}
        okText="轮换并强制停用"
        onCancel={() => {
          if (!submitting) closeRotateModal();
        }}
        onOk={() => rotateForm.submit()}
        open={Boolean(rotateConfig)}
        title="轮换 Stripe 凭据"
      >
        {rotateConfig && stripeSummary(rotateConfig) ? (
          <Alert
            className="page-alert"
            description={`${stripeSummary(rotateConfig)?.mode.toUpperCase()} · ${stripeSummary(rotateConfig)?.accountId}。账户和模式不可通过轮换修改；需要切换时请新建配置。旧 Webhook 凭据的宽限由服务端管理。`}
            message="提交后配置立即停用，必须重新测试"
            showIcon
            type="warning"
          />
        ) : null}
        <Form<StripeRotateForm>
          form={rotateForm}
          layout="vertical"
          onFinish={(values) => void rotateStripe(values)}
          preserve={false}
          requiredMark={false}
        >
          <Form.Item label="新 Stripe Secret Key" name="secretKey" rules={[
            { required: true, message: '请输入新 Secret Key' },
            { min: 16, max: 4096, message: '凭据长度无效' },
          ]}>
            <Input.Password autoComplete="new-password" maxLength={4096} visibilityToggle={false} />
          </Form.Item>
          <Form.Item label="新 Webhook Signing Secret" name="webhookSecret" rules={[
            { required: true, message: '请输入新 Webhook Signing Secret' },
            { min: 16, max: 4096, message: '凭据长度无效' },
          ]}>
            <Input.Password autoComplete="new-password" maxLength={4096} visibilityToggle={false} />
          </Form.Item>
        </Form>
      </Modal>

      {FAKE_PAYMENT_ENABLED ? (
        <Modal
          cancelText="取消"
          destroyOnHidden
          okButtonProps={{ danger: true }}
          okText="创建本地测试配置"
          confirmLoading={submitting === 'fake'}
          onCancel={() => {
            if (!submitting) {
              setFakeOpen(false);
              fakeForm.resetFields();
            }
          }}
          onOk={() => fakeForm.submit()}
          open={fakeOpen}
          title="Fake 支付·本地测试"
        >
          <Alert
            className="page-alert"
            description="该配置不接收任何密钥或支付凭据，仅用于开发联调。"
            message="禁止用于生产收款"
            showIcon
            type="error"
          />
          <Form<FakeConfigForm>
            form={fakeForm}
            layout="vertical"
            onFinish={(values) => void createFake(values)}
            requiredMark={false}
          >
            <Form.Item
              label="配置名称"
              name="label"
              rules={[
                { required: true, message: '请输入配置名称', whitespace: true },
                { max: 100, message: '最多 100 字' },
              ]}
            >
              <Input maxLength={100} placeholder="例如：本地联调" />
            </Form.Item>
          </Form>
        </Modal>
      ) : null}
    </>
  );
}

function firstConfigForMode(
  configs: PaymentConfigRecord[],
  mode: CollectionMode,
): PaymentConfigRecord | undefined {
  return configs.find((config) => configMatchesMode(config, mode));
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
