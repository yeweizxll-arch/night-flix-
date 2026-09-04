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
  Popconfirm,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  canEnableCommunication,
  communicationTestErrorLabel,
  type CommunicationChannel,
  type CommunicationConfigSummary,
  type PendingCommunicationTest,
  testHasSettled,
} from './communication-ui';

interface CommunicationConfig extends CommunicationConfigSummary {
  id: string;
  provider: 'resend' | 'twilio';
}

interface CredentialForm {
  accountSid?: string;
  apiKey?: string;
  authToken?: string;
  fromEmail?: string;
  fromPhone?: string;
}

interface TestForm {
  confirmed: boolean;
  destination: string;
}

interface TestRequestResponse {
  jobId: string;
  status: 'pending';
  version: number;
}

const API_BASE = '/api/v1/tenant/communications/configs';
const channels: CommunicationChannel[] = ['email', 'sms'];

export function TenantCommunicationSettingsPage() {
  const { principal, request } = useAuth();
  const [credentialForm] = Form.useForm<CredentialForm>();
  const [testForm] = Form.useForm<TestForm>();
  const [messageApi, messageContext] = message.useMessage();
  const [configs, setConfigs] = useState<CommunicationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<CommunicationChannel>();
  const [testChannel, setTestChannel] = useState<CommunicationChannel>();
  const [pendingTests, setPendingTests] = useState<Partial<Record<CommunicationChannel, PendingCommunicationTest>>>({});
  const [submitting, setSubmitting] = useState<string>();
  const loadSequence = useRef(0);

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes('tenant.communication.read');
  const canManage = permissions.includes('tenant.communication.manage');

  const load = useCallback(async () => {
    if (!canRead) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await request<{ items: CommunicationConfig[] }>(API_BASE);
      if (sequence !== loadSequence.current) return;
      setConfigs(result.items);
      setPendingTests((current) => {
        const next = { ...current };
        for (const channel of channels) {
          const pending = current[channel];
          if (pending && testHasSettled(
            result.items.find((config) => config.channel === channel), pending,
          )) delete next[channel];
        }
        return next;
      });
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(safeRequestError(reason, '通信配置加载失败'));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [canRead, request]);

  useEffect(() => { void load(); }, [load]);

  function openEditor(channel: CommunicationChannel): void {
    credentialForm.resetFields();
    setEditor(channel);
  }

  function closeEditor(): void {
    setEditor(undefined);
    credentialForm.resetFields();
  }

  function openTest(channel: CommunicationChannel): void {
    testForm.resetFields();
    testForm.setFieldsValue({ confirmed: false });
    setTestChannel(channel);
  }

  function closeTest(): void {
    setTestChannel(undefined);
    testForm.resetFields();
  }

  async function saveCredentials(values: CredentialForm): Promise<void> {
    if (!editor) return;
    const config = configs.find((item) => item.channel === editor);
    const credentials = editor === 'email'
      ? {
          apiKey: values.apiKey,
          fromEmail: values.fromEmail?.trim().toLowerCase(),
          type: 'resend',
        }
      : {
          accountSid: values.accountSid?.trim(),
          authToken: values.authToken,
          fromPhone: values.fromPhone?.trim(),
          type: 'twilio',
        };
    setSubmitting(`save:${editor}`);
    try {
      await request<CommunicationConfig>(`${API_BASE}/${editor}`, {
        body: JSON.stringify({ credentials, expectedVersion: config?.version ?? 0 }),
        method: 'PUT',
      });
      messageApi.success('凭据已加密保存；配置保持停用，请重新测试通过后再启用');
      setPendingTests((current) => ({ ...current, [editor]: undefined }));
      setEditor(undefined);
      credentialForm.resetFields();
      await load();
    } catch (reason) {
      messageApi.error(safeRequestError(reason, '凭据保存失败'));
      if (isConflict(reason)) {
        setEditor(undefined);
        credentialForm.resetFields();
        await load();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function requestTest(values: TestForm): Promise<void> {
    if (!testChannel) return;
    const config = configs.find((item) => item.channel === testChannel);
    if (!config) return;
    const channel = testChannel;
    setSubmitting(`test:${channel}`);
    try {
      const response = await request<TestRequestResponse>(`${API_BASE}/${channel}/test`, {
        body: JSON.stringify({
          destination: values.destination.trim(),
          expectedVersion: config.version,
        }),
        method: 'POST',
      });
      if (response.status !== 'pending') throw new Error('测试任务状态无效');
      setPendingTests((current) => ({
        ...current,
        [channel]: { version: response.version },
      }));
      setConfigs((current) => current.map((item) => item.channel === channel
        ? {
            ...item,
            lastTestError: undefined,
            lastTestStatus: undefined,
            lastTestedAt: undefined,
            status: 'disabled',
            version: response.version,
          }
        : item));
      messageApi.success('测试任务已提交，当前为 pending；请稍后刷新查看真实投递结果');
      setTestChannel(undefined);
      testForm.resetFields();
    } catch (reason) {
      messageApi.error(safeRequestError(reason, '测试任务提交失败'));
      if (isConflict(reason)) {
        setTestChannel(undefined);
        testForm.resetFields();
        await load();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function changeStatus(config: CommunicationConfig): Promise<void> {
    const action = config.status === 'active' ? 'disable' : 'enable';
    setSubmitting(`${action}:${config.channel}`);
    try {
      await request<CommunicationConfig>(`${API_BASE}/${config.channel}/${action}`, {
        body: JSON.stringify({ expectedVersion: config.version }),
        method: 'POST',
      });
      messageApi.success(action === 'enable' ? '通信渠道已启用' : '通信渠道已停用');
      setPendingTests((current) => ({ ...current, [config.channel]: undefined }));
      await load();
    } catch (reason) {
      messageApi.error(safeRequestError(reason, action === 'enable' ? '渠道启用失败' : '渠道停用失败'));
      if (isConflict(reason)) await load();
    } finally {
      setSubmitting(undefined);
    }
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>邮箱与短信验证码</Typography.Title>
          <Typography.Text type="secondary">
            配置 Resend 邮件和 Twilio 短信渠道；未配置或未启用时不会发送外部验证码。
          </Typography.Text>
        </div>
        <Button disabled={Boolean(submitting)} loading={loading} onClick={() => void load()}>刷新状态</Button>
      </div>
      <Alert
        className="page-alert"
        description="凭据只写入加密存储，后台永不回显。每次替换凭据都会自动停用渠道，必须等待真实测试结果为通过后才能重新启用。"
        message="安全提示"
        showIcon
        type="info"
      />
      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}
      {!loading && !configs.length ? (
        <Empty description="尚未配置邮件或短信渠道；可分别录入所需渠道的凭据" />
      ) : null}
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {channels.map((channel) => {
          const config = configs.find((item) => item.channel === channel);
          const pending = pendingTests[channel];
          const enableAllowed = canEnableCommunication(config, pending);
          return (
            <Card
              key={channel}
              loading={loading}
              title={channel === 'email' ? 'Email · Resend' : 'SMS · Twilio'}
              extra={config?.status === 'active'
                ? <Tag color="green">已启用</Tag>
                : <Tag>已停用</Tag>}
            >
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Space size={[8, 8]} wrap>
                  <Tag color={config ? 'blue' : undefined}>{config ? '凭据已配置·不回显' : '未配置'}</Tag>
                  {pending ? <Tag color="processing">测试 pending</Tag> : <TestStatusTag config={config} />}
                  {config ? <Typography.Text type="secondary">版本 {config.version}</Typography.Text> : null}
                  {config?.lastTestedAt && !pending ? (
                    <Typography.Text type="secondary">测试时间 {formatDateTime(config.lastTestedAt)}</Typography.Text>
                  ) : null}
                </Space>
                {config?.lastTestStatus === 'failed' && !pending ? (
                  <Alert message={communicationTestErrorLabel(config.lastTestError)} showIcon type="warning" />
                ) : null}
                <Space wrap>
                  {canManage ? (
                    <Button disabled={Boolean(submitting)} onClick={() => openEditor(channel)}>{config ? '替换凭据' : '录入凭据'}</Button>
                  ) : null}
                  {canManage && config ? (
                    <Button disabled={Boolean(pending) || Boolean(submitting)} onClick={() => openTest(channel)}>发送真实测试</Button>
                  ) : null}
                  {canManage && config ? (
                    <Popconfirm
                      disabled={config.status === 'disabled' && !enableAllowed}
                      onConfirm={() => void changeStatus(config)}
                      title={config.status === 'active'
                        ? '确认停用该通信渠道？'
                        : '仅测试通过的当前版本可以启用，确认继续？'}
                    >
                      <Button
                        danger={config.status === 'active'}
                        disabled={Boolean(submitting) || (config.status === 'disabled' && !enableAllowed)}
                        loading={submitting === `${config.status === 'active' ? 'disable' : 'enable'}:${channel}`}
                      >{config.status === 'active' ? '停用' : '启用'}</Button>
                    </Popconfirm>
                  ) : null}
                  {!canManage ? <Typography.Text type="secondary">只读</Typography.Text> : null}
                </Space>
                {canManage && config?.status === 'disabled' && !enableAllowed ? (
                  <Typography.Text type="secondary">启用按钮会在当前版本真实测试通过后开放。</Typography.Text>
                ) : null}
              </Space>
            </Card>
          );
        })}
      </Space>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeEditor}
        open={Boolean(editor)}
        title={editor === 'email' ? '录入 Resend 凭据' : '录入 Twilio 凭据'}
      >
        <Alert className="page-alert" message="已有密钥不会回显。本次提交必须填写完整的新凭据，关闭窗口即清空输入。" showIcon type="warning" />
        <Form
          form={credentialForm}
          layout="vertical"
          onFinish={(values) => void saveCredentials(values)}
          preserve={false}
        >
          {editor === 'email' ? (
            <>
              <Form.Item label="Resend API Key" name="apiKey" rules={[
                { required: true },
                { pattern: /^re_[A-Za-z0-9_-]{16,200}$/, message: '请输入有效的 Resend API Key' },
              ]}>
                <Input.Password autoComplete="new-password" maxLength={203} visibilityToggle={false} />
              </Form.Item>
              <Form.Item label="From Email" name="fromEmail" rules={[{ required: true, type: 'email' }]}>
                <Input autoComplete="off" maxLength={320} placeholder="noreply@example.com" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item label="Twilio Account SID" name="accountSid" rules={[
                { required: true },
                { pattern: /^AC[0-9a-fA-F]{32}$/, message: '请输入有效的 Twilio Account SID' },
              ]}>
                <Input.Password autoComplete="new-password" maxLength={34} visibilityToggle={false} />
              </Form.Item>
              <Form.Item label="Twilio Auth Token" name="authToken" rules={[
                { min: 16, max: 200, required: true },
                { pattern: /^[A-Za-z0-9_-]+$/, message: 'Auth Token 格式无效' },
              ]}>
                <Input.Password autoComplete="new-password" maxLength={200} visibilityToggle={false} />
              </Form.Item>
              <Form.Item label="From Phone" name="fromPhone" rules={[
                { required: true },
                { pattern: /^\+[1-9][0-9]{7,14}$/, message: '请输入 E.164 手机号' },
              ]}>
                <Input autoComplete="off" maxLength={16} placeholder="+12025550123" />
              </Form.Item>
            </>
          )}
          <Button block htmlType="submit" loading={submitting === `save:${editor}`} type="primary">
            保存并停用，等待重新测试
          </Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeTest}
        open={Boolean(testChannel)}
        title={testChannel === 'email' ? '发送真实邮件测试' : '发送真实短信测试'}
      >
        <Alert className="page-alert" message="测试会真实调用当前渠道并发送一次验证码，提交后结果先显示为 pending。" showIcon type="warning" />
        <Form form={testForm} layout="vertical" onFinish={(values) => void requestTest(values)} preserve={false}>
          <Form.Item
            label={testChannel === 'email' ? '测试邮箱' : '测试手机号'}
            name="destination"
            rules={testChannel === 'email'
              ? [{ required: true, type: 'email' }]
              : [{ required: true }, { pattern: /^\+[1-9][0-9]{7,14}$/, message: '请输入 E.164 手机号' }]}
          >
            <Input autoComplete="off" maxLength={testChannel === 'email' ? 320 : 16} />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmValidator }]} valuePropName="checked">
            <Checkbox>我确认向上述地址发送一次真实测试验证码</Checkbox>
          </Form.Item>
          <Button block htmlType="submit" loading={submitting === `test:${testChannel}`} type="primary">提交测试任务</Button>
        </Form>
      </Modal>
    </>
  );
}

function TestStatusTag({ config }: { config?: CommunicationConfig }) {
  if (!config?.lastTestStatus) return <Tag>未测试</Tag>;
  return config.lastTestStatus === 'passed'
    ? <Tag color="green">测试通过</Tag>
    : <Tag color="red">测试失败</Tag>;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

async function confirmValidator(_: unknown, value: boolean): Promise<void> {
  if (!value) throw new Error('请先确认测试会真实发送消息');
}

function safeRequestError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback;
  if (reason.status === 400) return '输入格式不正确，请核对当前渠道的字段';
  if (reason.status === 401) return '登录状态已失效，请重新登录';
  if (reason.status === 403) return '当前账号无权操作，或代理商状态不可用';
  if (reason.status === 404) return '通信配置不存在，请刷新后重试';
  if (reason.status === 409) return '配置版本已变化，页面将刷新，请重新操作';
  if (reason.status === 429) return '测试请求过于频繁，请稍后再试';
  if (reason.status === 503) return '通信加密或渠道服务暂不可用，请联系管理员';
  return fallback;
}

function isConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}
