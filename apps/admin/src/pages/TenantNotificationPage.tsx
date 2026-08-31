import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  canEnableNotificationProvider,
  providerConfigPayload,
  providerEnvironmentLabel,
  safeNotificationTestError,
  type PushProviderEnvironment,
} from './notification-ui';

type Provider = 'apns' | 'fcm';
type Channel = 'in_app' | 'push';
type CampaignStatus = 'draft' | 'scheduled' | 'dispatching' | 'completed' | 'cancelled';
type NotificationLocale = 'zh-CN' | 'zh-TW' | 'en-US' | 'fr-FR' | 'ja-JP' | 'ko-KR';

interface ProviderConfig {
  environment: PushProviderEnvironment;
  id: string;
  lastTestError?: string;
  lastTestStatus?: 'failed' | 'passed';
  lastTestedAt?: string;
  provider: Provider;
  status: 'active' | 'disabled';
  version: number;
}

interface CampaignSummary {
  channels: Channel[];
  createdAt: string;
  id: string;
  name: string;
  scheduledAt?: string;
  status: CampaignStatus;
  targetType: 'all' | 'conditions';
  version: number;
}

interface CampaignDetail extends Omit<CampaignSummary, 'createdAt' | 'targetType'> {
  deepLink?: string;
  target: {
    conditions?: {
      locales?: NotificationLocale[];
      registeredAfter?: string;
      registeredBefore?: string;
    };
    type: 'all' | 'conditions';
  };
  translations: Array<{ body: string; locale: NotificationLocale; title: string }>;
}

interface CampaignListResponse {
  items: CampaignSummary[];
  page: number;
  pageSize: number;
}

interface CampaignFormValues {
  channels: Channel[];
  deepLink?: string;
  name: string;
  registeredAfter?: string;
  registeredBefore?: string;
  targetLocales?: NotificationLocale[];
  targetType: 'all' | 'conditions';
  translations: Array<{ body: string; locale: NotificationLocale; title: string }>;
}

interface ApnsCredentials {
  bundleId: string;
  environment: PushProviderEnvironment;
  keyId: string;
  privateKey: string;
  teamId: string;
}

interface FcmCredentials {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

const API_BASE = '/api/v1/tenant/notifications';
const locales: Array<{ label: string; value: NotificationLocale }> = [
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: 'English', value: 'en-US' },
  { label: 'Français', value: 'fr-FR' },
  { label: '日本語', value: 'ja-JP' },
  { label: '한국어', value: 'ko-KR' },
];
const campaignStatus: Record<CampaignStatus, { color?: string; label: string }> = {
  cancelled: { label: '已取消' },
  completed: { color: 'green', label: '已完成' },
  dispatching: { color: 'blue', label: '发送中' },
  draft: { label: '草稿' },
  scheduled: { color: 'gold', label: '已排期' },
};

export function TenantNotificationPage() {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [credentialForm] = Form.useForm<ApnsCredentials & FcmCredentials>();
  const [campaignForm] = Form.useForm<CampaignFormValues>();
  const [scheduleForm] = Form.useForm<{ scheduledAt: string }>();
  const [cancelForm] = Form.useForm<{ reason: string }>();
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const [credentialProvider, setCredentialProvider] = useState<Provider>();
  const [configSubmitting, setConfigSubmitting] = useState<string>();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignPage, setCampaignPage] = useState(1);
  const [campaignPageSize, setCampaignPageSize] = useState(20);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [campaignError, setCampaignError] = useState<string>();
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<CampaignDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [editorTarget, setEditorTarget] = useState<CampaignDetail | 'new'>();
  const [scheduleTarget, setScheduleTarget] = useState<CampaignSummary | CampaignDetail>();
  const [cancelTarget, setCancelTarget] = useState<CampaignSummary | CampaignDetail>();
  const [campaignSubmitting, setCampaignSubmitting] = useState<string>();
  const campaignSequence = useRef(0);
  const detailSequence = useRef(0);
  const canManageConfig = principal?.permissions.includes('tenant.notification.config.manage') ?? false;
  const canManageCampaign = principal?.permissions.includes('tenant.notification.campaign.manage') ?? false;

  const loadConfigs = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(undefined);
    try {
      setConfigs(await request<ProviderConfig[]>(`${API_BASE}/provider-configs`));
    } catch (reason) {
      setConfigError(errorMessage(reason, '推送渠道加载失败'));
    } finally {
      setConfigLoading(false);
    }
  }, [request]);

  const loadCampaigns = useCallback(async (page = campaignPage, pageSize = campaignPageSize) => {
    const sequence = ++campaignSequence.current;
    setCampaignLoading(true);
    setCampaignError(undefined);
    try {
      const parameters = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const result = await request<CampaignListResponse>(`${API_BASE}/campaigns?${parameters}`);
      if (sequence === campaignSequence.current) {
        setCampaigns(result.items);
        setCampaignPage(result.page);
        setCampaignPageSize(result.pageSize);
      }
    } catch (reason) {
      if (sequence === campaignSequence.current) {
        setCampaignError(errorMessage(reason, '群发活动加载失败'));
      }
    } finally {
      if (sequence === campaignSequence.current) setCampaignLoading(false);
    }
  }, [campaignPage, campaignPageSize, request]);

  useEffect(() => {
    void Promise.all([loadConfigs(), loadCampaigns(1, 20)]);
  // Initial load is intentionally fixed to the first page.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadConfigs]);

  function configFor(provider: Provider): ProviderConfig | undefined {
    return configs.find((config) => config.provider === provider);
  }

  function openCredentials(provider: Provider): void {
    credentialForm.resetFields();
    credentialForm.setFieldValue(
      'environment',
      provider === 'apns' ? configFor(provider)?.environment ?? 'production' : 'production',
    );
    setCredentialProvider(provider);
  }

  function closeCredentials(): void {
    if (configSubmitting) return;
    credentialForm.resetFields();
    setCredentialProvider(undefined);
  }

  async function saveCredentials(values: ApnsCredentials & FcmCredentials): Promise<void> {
    if (!credentialProvider) return;
    const provider = credentialProvider;
    const current = configFor(provider);
    const payload = providerConfigPayload(provider, values, current?.version ?? 0);
    setConfigSubmitting(`save:${provider}`);
    try {
      await request(`${API_BASE}/provider-configs/${provider}`, {
        body: JSON.stringify(payload),
        method: 'PUT',
      });
      credentialForm.resetFields();
      setCredentialProvider(undefined);
      messageApi.success('凭据已安全替换，需重新通过真实测试后才能启用');
      await loadConfigs();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '凭据保存失败'));
    } finally {
      setConfigSubmitting(undefined);
    }
  }

  async function mutateConfig(provider: Provider, action: 'disable' | 'enable' | 'test'): Promise<void> {
    const current = configFor(provider);
    if (!current) return;
    setConfigSubmitting(`${action}:${provider}`);
    try {
      const result = await request<{ jobId?: string; status: string }>(
        `${API_BASE}/provider-configs/${provider}/${action}`,
        { body: JSON.stringify({ expectedVersion: current.version }), method: 'POST' },
      );
      if (action === 'test') {
        messageApi.info(result.status === 'pending'
          ? '真实测试任务已提交；请稍后刷新查看结果，此处不预先判定成功。'
          : '测试状态已更新。');
      } else {
        messageApi.success(action === 'enable' ? '渠道已启用' : '渠道已停用');
      }
      await loadConfigs();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '渠道操作失败'));
      await loadConfigs();
    } finally {
      setConfigSubmitting(undefined);
    }
  }

  const loadDetail = useCallback(async (campaignId: string) => {
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const result = await request<CampaignDetail>(`${API_BASE}/campaigns/${encodeURIComponent(campaignId)}`);
      if (sequence === detailSequence.current) setDetail(result);
    } catch (reason) {
      if (sequence === detailSequence.current) {
        setDetailError(errorMessage(reason, '活动详情加载失败'));
      }
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }, [request]);

  function openDetail(campaignId: string): void {
    detailSequence.current += 1;
    setDetailId(campaignId);
    setDetail(undefined);
    void loadDetail(campaignId);
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    setDetailId(undefined);
    setDetail(undefined);
    setDetailError(undefined);
  }

  function openCreate(): void {
    campaignForm.resetFields();
    campaignForm.setFieldsValue({
      channels: ['in_app'],
      targetType: 'all',
      translations: [{ body: '', locale: 'zh-CN', title: '' }],
    });
    setEditorTarget('new');
  }

  function openEdit(target: CampaignDetail): void {
    campaignForm.resetFields();
    campaignForm.setFieldsValue({
      channels: target.channels,
      deepLink: target.deepLink,
      name: target.name,
      registeredAfter: toLocalDateTime(target.target.conditions?.registeredAfter),
      registeredBefore: toLocalDateTime(target.target.conditions?.registeredBefore),
      targetLocales: target.target.conditions?.locales,
      targetType: target.target.type,
      translations: target.translations,
    });
    setEditorTarget(target);
  }

  function closeEditor(): void {
    if (campaignSubmitting) return;
    campaignForm.resetFields();
    setEditorTarget(undefined);
  }

  async function saveCampaign(values: CampaignFormValues): Promise<void> {
    if (!editorTarget) return;
    let registeredAfter: string | undefined;
    let registeredBefore: string | undefined;
    try {
      registeredAfter = optionalIso(values.registeredAfter);
      registeredBefore = optionalIso(values.registeredBefore);
    } catch {
      messageApi.error('请输入有效的注册时间条件');
      return;
    }
    const target = values.targetType === 'all' ? { type: 'all' as const } : {
      conditions: {
        ...(values.targetLocales?.length ? { locales: values.targetLocales } : {}),
        ...(registeredAfter ? { registeredAfter } : {}),
        ...(registeredBefore ? { registeredBefore } : {}),
      },
      type: 'conditions' as const,
    };
    const payload = {
      channels: values.channels,
      ...(values.deepLink?.trim() ? { deepLink: values.deepLink.trim() } : {}),
      name: values.name.trim(),
      target,
      translations: values.translations.map((item) => ({
        body: item.body.trim(), locale: item.locale, title: item.title.trim(),
      })),
      ...(editorTarget === 'new' ? {} : { expectedVersion: editorTarget.version }),
    };
    setCampaignSubmitting('save');
    try {
      const path = editorTarget === 'new'
        ? `${API_BASE}/campaigns`
        : `${API_BASE}/campaigns/${encodeURIComponent(editorTarget.id)}`;
      await request(path, { body: JSON.stringify(payload), method: editorTarget === 'new' ? 'POST' : 'PUT' });
      messageApi.success(editorTarget === 'new' ? '活动草稿已创建' : '活动草稿已更新');
      const editedId = editorTarget === 'new' ? undefined : editorTarget.id;
      campaignForm.resetFields();
      setEditorTarget(undefined);
      await loadCampaigns(1, campaignPageSize);
      if (editedId && detailId === editedId) await loadDetail(editedId);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '活动保存失败'));
    } finally {
      setCampaignSubmitting(undefined);
    }
  }

  function openSchedule(target: CampaignSummary | CampaignDetail): void {
    scheduleForm.resetFields();
    setScheduleTarget(target);
  }

  async function scheduleCampaign(values: { scheduledAt: string }): Promise<void> {
    if (!scheduleTarget) return;
    let scheduledAt: string;
    try {
      scheduledAt = requiredIso(values.scheduledAt);
    } catch {
      messageApi.error('请输入有效的排期时间');
      return;
    }
    const target = scheduleTarget;
    setCampaignSubmitting(`schedule:${target.id}`);
    try {
      await request(`${API_BASE}/campaigns/${encodeURIComponent(target.id)}/schedule`, {
        body: JSON.stringify({ expectedVersion: target.version, scheduledAt }), method: 'POST',
      });
      messageApi.success('活动已排期');
      scheduleForm.resetFields();
      setScheduleTarget(undefined);
      await loadCampaigns(1, campaignPageSize);
      if (detailId === target.id) await loadDetail(target.id);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '活动排期失败'));
      if (reason instanceof ApiError && reason.status === 409) {
        await loadCampaigns(1, campaignPageSize);
        if (detailId === target.id) await loadDetail(target.id);
      }
    } finally {
      setCampaignSubmitting(undefined);
    }
  }

  function openCancel(target: CampaignSummary | CampaignDetail): void {
    cancelForm.resetFields();
    setCancelTarget(target);
  }

  async function cancelCampaign(values: { reason: string }): Promise<void> {
    if (!cancelTarget) return;
    const target = cancelTarget;
    setCampaignSubmitting(`cancel:${target.id}`);
    try {
      await request(`${API_BASE}/campaigns/${encodeURIComponent(target.id)}/cancel`, {
        body: JSON.stringify({ expectedVersion: target.version, reason: values.reason.trim() }), method: 'POST',
      });
      messageApi.success('已取消未发送部分；已投递的站内消息保留');
      cancelForm.resetFields();
      setCancelTarget(undefined);
      await loadCampaigns(1, campaignPageSize);
      if (detailId === target.id) await loadDetail(target.id);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '取消活动失败'));
      if (reason instanceof ApiError && reason.status === 409) {
        await loadCampaigns(1, campaignPageSize);
        if (detailId === target.id) await loadDetail(target.id);
      }
    } finally {
      setCampaignSubmitting(undefined);
    }
  }

  const campaignActions = (record: CampaignSummary | CampaignDetail) => (
    <Space size={6} wrap>
      <Button size="small" onClick={() => openDetail(record.id)}>详情</Button>
      {canManageCampaign && record.status === 'draft' ? (
        <Button size="small" onClick={() => {
          if ('translations' in record) openEdit(record);
          else {
            openDetail(record.id);
            messageApi.info('正在加载详情，可在抽屉中编辑。');
          }
        }}>编辑</Button>
      ) : null}
      {canManageCampaign && record.status === 'draft' ? (
        <Button size="small" type="primary" onClick={() => openSchedule(record)}>排期</Button>
      ) : null}
      {canManageCampaign && ['draft', 'scheduled', 'dispatching'].includes(record.status) ? (
        <Button danger size="small" onClick={() => openCancel(record)}>取消</Button>
      ) : null}
    </Space>
  );

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>通知运营</Typography.Title>
          <Typography.Text type="secondary">管理真实推送渠道与多语言群发活动。</Typography.Text>
        </div>
      </div>
      <Alert
        className="page-alert"
        description="提交测试只会创建真实测试任务；未安装对应适配器、未配置或未通过测试的渠道都不会推送。"
        message="不伪造测试成功"
        showIcon
        type="warning"
      />
      <Tabs items={[
        {
          children: (
            <ProviderConfigs
              canManage={canManageConfig}
              configs={configs}
              error={configError}
              loading={configLoading}
              mutating={configSubmitting}
              onCredentials={openCredentials}
              onMutate={(provider, action) => void mutateConfig(provider, action)}
              onReload={() => void loadConfigs()}
            />
          ),
          key: 'providers',
          label: '推送渠道',
        },
        {
          children: (
            <Card
              extra={canManageCampaign ? <Button type="primary" onClick={openCreate}>新建草稿</Button> : null}
              title="群发活动"
            >
              {campaignError ? (
                <Alert action={<Button size="small" onClick={() => void loadCampaigns()}>重试</Button>}
                  message={campaignError} showIcon type="error" />
              ) : null}
              <Table<CampaignSummary>
                columns={[
                  { dataIndex: 'name', title: '活动名称', render: (value, record) => (
                    <Space direction="vertical" size={0}>
                      <Button className="table-link-button" type="link" onClick={() => openDetail(record.id)}>{value}</Button>
                      <Typography.Text className="secondary-id" type="secondary">{record.id}</Typography.Text>
                    </Space>
                  ) },
                  { dataIndex: 'channels', title: '渠道', render: (value: Channel[]) => value.map(channelLabel).join(' + ') },
                  { dataIndex: 'targetType', title: '人群', render: (value) => value === 'all' ? '全部用户' : '条件人群' },
                  { dataIndex: 'status', title: '状态', render: (value: CampaignStatus) => <StatusTag status={value} /> },
                  { dataIndex: 'scheduledAt', title: '排期', render: (value?: string) => value ? formatDateTime(value) : '—' },
                  { dataIndex: 'version', title: '版本', width: 75 },
                  { key: 'action', title: '操作', render: (_, record) => campaignActions(record), width: 260 },
                ]}
                dataSource={campaigns}
                loading={campaignLoading}
                locale={{ emptyText: <Empty description="暂无群发活动" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                pagination={{
                  current: campaignPage,
                  onChange: (page, pageSize) => void loadCampaigns(page, pageSize),
                  pageSize: campaignPageSize,
                  pageSizeOptions: [10, 20, 50],
                  showSizeChanger: true,
                  total: (campaignPage - 1) * campaignPageSize + campaigns.length
                    + (campaigns.length === campaignPageSize ? 1 : 0),
                }}
                rowKey="id"
                scroll={{ x: 1050 }}
              />
            </Card>
          ),
          key: 'campaigns',
          label: '群发活动',
        },
      ]} />

      <CredentialModal
        form={credentialForm}
        loading={configSubmitting === `save:${credentialProvider}`}
        onCancel={closeCredentials}
        onFinish={(values) => void saveCredentials(values)}
        provider={credentialProvider}
      />

      <Drawer destroyOnHidden extra={detail ? campaignActions(detail) : null} onClose={closeDetail}
        open={Boolean(detailId)} title="活动详情" width={760}>
        {detailLoading ? <Spin /> : detailError ? (
          <Alert action={<Button size="small" onClick={() => detailId && void loadDetail(detailId)}>重试</Button>}
            message={detailError} showIcon type="error" />
        ) : detail ? <CampaignDetailView detail={detail} /> : null}
      </Drawer>

      <CampaignEditor form={campaignForm} loading={campaignSubmitting === 'save'} onCancel={closeEditor}
        onFinish={(values) => void saveCampaign(values)} open={Boolean(editorTarget)}
        title={editorTarget === 'new' ? '新建群发草稿' : '编辑群发草稿'} />

      <Modal destroyOnHidden confirmLoading={Boolean(campaignSubmitting?.startsWith('schedule:'))}
        onCancel={() => { if (!campaignSubmitting) { scheduleForm.resetFields(); setScheduleTarget(undefined); } }}
        onOk={() => scheduleForm.submit()} open={Boolean(scheduleTarget)} title="排期群发活动">
        <Alert className="page-alert" message={`当前活动版本 ${scheduleTarget?.version ?? '—'}。服务端只允许草稿进入排期。`}
          showIcon type="info" />
        <Form form={scheduleForm} layout="vertical" onFinish={(values) => void scheduleCampaign(values)}>
          <Form.Item label="发送时间" name="scheduledAt" rules={[{ required: true, message: '请选择发送时间' }]}>
            <Input type="datetime-local" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal destroyOnHidden confirmLoading={Boolean(campaignSubmitting?.startsWith('cancel:'))}
        okButtonProps={{ danger: true }} okText="确认取消"
        onCancel={() => { if (!campaignSubmitting) { cancelForm.resetFields(); setCancelTarget(undefined); } }}
        onOk={() => cancelForm.submit()} open={Boolean(cancelTarget)} title="取消群发活动">
        <Alert className="page-alert" description="发送中活动只会停止尚未发送的部分；已投递的站内消息不会撤回。"
          message="请确认影响范围" showIcon type="warning" />
        <Form form={cancelForm} layout="vertical" onFinish={(values) => void cancelCampaign(values)}>
          <Form.Item label="取消原因" name="reason" rules={[
            { required: true, message: '请输入取消原因', whitespace: true },
            { max: 1000, message: '最多 1000 字' },
          ]}><Input.TextArea maxLength={1000} rows={4} showCount /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ProviderConfigs(props: {
  canManage: boolean;
  configs: ProviderConfig[];
  error?: string;
  loading: boolean;
  mutating?: string;
  onCredentials: (provider: Provider) => void;
  onMutate: (provider: Provider, action: 'disable' | 'enable' | 'test') => void;
  onReload: () => void;
}) {
  return (
    <Card extra={<Button loading={props.loading} onClick={props.onReload}>刷新状态</Button>} title="推送渠道配置">
      {props.error ? <Alert action={<Button size="small" onClick={props.onReload}>重试</Button>}
        className="page-alert" message={props.error} showIcon type="error" /> : null}
      <Spin spinning={props.loading}>
        <Row gutter={[16, 16]}>
          {(['apns', 'fcm'] as const).map((provider) => {
            const config = props.configs.find((item) => item.provider === provider);
            const busy = Boolean(props.mutating?.endsWith(`:${provider}`));
            return (
              <Col key={provider} xs={24} xl={12}>
                <Card size="small" title={provider === 'apns' ? 'Apple APNs' : 'Firebase FCM'}>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="配置">{config ? '已安全保存（凭据不回显）' : '未配置'}</Descriptions.Item>
                    <Descriptions.Item label="环境">
                      {config ? (
                        <Tag color={config.environment === 'sandbox' ? 'gold' : 'blue'}>
                          {providerEnvironmentLabel(provider, config.environment)}
                        </Tag>
                      ) : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="状态"><Tag color={config?.status === 'active' ? 'green' : undefined}>
                      {config?.status === 'active' ? '已启用' : '已停用'}</Tag></Descriptions.Item>
                    <Descriptions.Item label="真实测试">{testResult(config)}</Descriptions.Item>
                    <Descriptions.Item label="测试时间">{config?.lastTestedAt ? formatDateTime(config.lastTestedAt) : '—'}</Descriptions.Item>
                    <Descriptions.Item label="版本">{config?.version ?? '—'}</Descriptions.Item>
                  </Descriptions>
                  {config?.lastTestError ? <Alert className="page-alert" message={safeNotificationTestError(config.lastTestError)} showIcon type="warning" /> : null}
                  {props.canManage ? (
                    <Space wrap>
                      <Button disabled={busy} onClick={() => props.onCredentials(provider)}>{config ? '替换凭据' : '录入凭据'}</Button>
                      <Button disabled={!config || busy} loading={props.mutating === `test:${provider}`}
                        onClick={() => props.onMutate(provider, 'test')}>提交真实测试</Button>
                      {config?.status === 'active' ? (
                        <Button danger disabled={busy} loading={props.mutating === `disable:${provider}`}
                          onClick={() => props.onMutate(provider, 'disable')}>停用</Button>
                      ) : (
                        <Button disabled={!canEnableNotificationProvider(config) || busy} type="primary"
                          loading={props.mutating === `enable:${provider}`}
                          onClick={() => props.onMutate(provider, 'enable')}>启用</Button>
                      )}
                    </Space>
                  ) : null}
                </Card>
              </Col>
            );
          })}
        </Row>
      </Spin>
    </Card>
  );
}

function CredentialModal(props: {
  form: ReturnType<typeof Form.useForm<ApnsCredentials & FcmCredentials>>[0];
  loading: boolean;
  onCancel: () => void;
  onFinish: (values: ApnsCredentials & FcmCredentials) => void;
  provider?: Provider;
}) {
  const environment = Form.useWatch('environment', props.form);
  const privateKeyRules = [
    { required: true, message: '请输入私钥' },
    { min: 32, message: '私钥长度不足' },
  ];
  return (
    <Modal destroyOnHidden confirmLoading={props.loading} onCancel={props.onCancel}
      onOk={() => props.form.submit()} open={Boolean(props.provider)} title={`${props.provider === 'apns' ? 'APNs' : 'FCM'} 凭据`}>
      <Alert className="page-alert" description="凭据仅在本次提交时写入，后端与本页都不会回显。关闭窗口会立即清空输入。"
        message="敏感凭据" showIcon type="warning" />
      <Form autoComplete="off" form={props.form} layout="vertical" onFinish={props.onFinish}>
        {props.provider === 'apns' ? (
          <>
            <Form.Item label="APNs 环境" name="environment" rules={[{ required: true }]}>
              <Select options={[
                { label: 'Sandbox（测试安装包）', value: 'sandbox' },
                { label: 'Production（上架包）', value: 'production' },
              ]} />
            </Form.Item>
            <Alert
              className="page-alert"
              description={environment === 'sandbox'
                ? '当前用于测试安装包的 APNs Sandbox。上架包无法使用此环境。'
                : '当前用于 TestFlight / App Store 等上架包的 APNs Production。开发测试包应选 Sandbox。'}
              message="环境必须与 App 签名类型一致"
              showIcon
              type={environment === 'sandbox' ? 'warning' : 'info'}
            />
            <Form.Item label="Bundle ID" name="bundleId" rules={[{ required: true, whitespace: true }]}><Input autoComplete="off" maxLength={200} /></Form.Item>
            <Row gutter={12}>
              <Col span={12}><Form.Item label="Team ID" name="teamId" rules={[{ required: true, whitespace: true }]}><Input autoComplete="off" maxLength={100} /></Form.Item></Col>
              <Col span={12}><Form.Item label="Key ID" name="keyId" rules={[{ required: true, whitespace: true }]}><Input autoComplete="off" maxLength={100} /></Form.Item></Col>
            </Row>
          </>
        ) : (
          <>
            <Alert className="page-alert" description="FCM 后端固定使用 Production，不提供可切换环境。"
              message="FCM Production" showIcon type="info" />
            <Form.Item label="Project ID" name="projectId" rules={[{ required: true, whitespace: true }]}><Input autoComplete="off" maxLength={200} /></Form.Item>
            <Form.Item label="Client Email" name="clientEmail" rules={[{ required: true, type: 'email' }]}><Input autoComplete="off" maxLength={320} /></Form.Item>
          </>
        )}
        <Form.Item label="Private Key" name="privateKey" rules={privateKeyRules}>
          <Input.TextArea autoComplete="new-password" maxLength={20_000} rows={7} />
        </Form.Item>
        <Typography.Text type="secondary">
          保存凭据或修改 APNs 环境后，渠道会自动停用并清除上次测试结果，必须重新通过真实测试才能启用。
        </Typography.Text>
      </Form>
    </Modal>
  );
}

function CampaignEditor(props: {
  form: ReturnType<typeof Form.useForm<CampaignFormValues>>[0];
  loading: boolean;
  onCancel: () => void;
  onFinish: (values: CampaignFormValues) => void;
  open: boolean;
  title: string;
}) {
  const targetType = Form.useWatch('targetType', props.form);
  return (
    <Modal destroyOnHidden confirmLoading={props.loading} onCancel={props.onCancel}
      onOk={() => props.form.submit()} open={props.open} title={props.title} width={820}>
      <Form form={props.form} layout="vertical" onFinish={props.onFinish} requiredMark={false}>
        <Form.Item label="活动名称" name="name" rules={[{ required: true, whitespace: true }, { max: 200 }]}><Input maxLength={200} /></Form.Item>
        <Form.Item label="投递渠道" name="channels" rules={[{ required: true, message: '至少选择一个渠道' }]}>
          <Checkbox.Group options={[{ label: '站内信', value: 'in_app' }, { label: '移动推送', value: 'push' }]} />
        </Form.Item>
        <Form.Item label="站内深链（可选）" name="deepLink" rules={[
          { max: 1000 },
          { pattern: /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/, message: '只允许以 / 开头的站内路由' },
        ]}><Input maxLength={1000} placeholder="/dramas/example" /></Form.Item>
        <Form.Item label="目标人群" name="targetType" rules={[{ required: true }]}>
          <Select options={[{ label: '全部用户', value: 'all' }, { label: '条件人群', value: 'conditions' }]} />
        </Form.Item>
        {targetType === 'conditions' ? (
          <Card size="small" title="受控人群条件">
            <Form.Item label="用户语言" name="targetLocales"><Checkbox.Group options={locales} /></Form.Item>
            <Row gutter={12}>
              <Col span={12}><Form.Item label="注册时间不早于" name="registeredAfter"><Input type="datetime-local" /></Form.Item></Col>
              <Col span={12}><Form.Item label="注册时间早于" name="registeredBefore"><Input type="datetime-local" /></Form.Item></Col>
            </Row>
          </Card>
        ) : null}
        <Typography.Title level={5} style={{ marginTop: 20 }}>多语言内容</Typography.Title>
        <Form.List name="translations" rules={[{
          validator: async (_, values: CampaignFormValues['translations'] | undefined) => {
            const selected = values?.map((item) => item?.locale).filter(Boolean) ?? [];
            if (selected.length !== new Set(selected).size) throw new Error('语言不能重复');
          },
        }]}>
          {(fields, { add, remove }, { errors }) => (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {fields.map((field, index) => (
                <Card key={field.key} size="small" title={`语言 ${index + 1}`}
                  extra={fields.length > 1 ? <Button danger size="small" onClick={() => remove(field.name)}>删除</Button> : null}>
                  <Form.Item label="语言" name={[field.name, 'locale']} rules={[{ required: true }]}><Select options={locales} /></Form.Item>
                  <Form.Item label="标题" name={[field.name, 'title']} rules={[{ required: true, whitespace: true }, { max: 200 }]}><Input maxLength={200} /></Form.Item>
                  <Form.Item label="正文" name={[field.name, 'body']} rules={[{ required: true, whitespace: true }, { max: 2000 }]}><Input.TextArea maxLength={2000} rows={4} showCount /></Form.Item>
                </Card>
              ))}
              <Form.ErrorList errors={errors} />
              <Button disabled={fields.length >= locales.length} onClick={() => add({ body: '', locale: undefined, title: '' })}>添加语言</Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

function CampaignDetailView({ detail }: { detail: CampaignDetail }) {
  const conditions = detail.target.conditions;
  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <Descriptions bordered column={2} size="small">
        <Descriptions.Item label="活动名" span={2}>{detail.name}</Descriptions.Item>
        <Descriptions.Item label="状态"><StatusTag status={detail.status} /></Descriptions.Item>
        <Descriptions.Item label="版本">{detail.version}</Descriptions.Item>
        <Descriptions.Item label="渠道">{detail.channels.map(channelLabel).join(' + ')}</Descriptions.Item>
        <Descriptions.Item label="排期">{detail.scheduledAt ? formatDateTime(detail.scheduledAt) : '—'}</Descriptions.Item>
        <Descriptions.Item label="站内路由" span={2}><Typography.Text code>{detail.deepLink || '—'}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="人群" span={2}>{detail.target.type === 'all' ? '全部用户' : '条件人群'}</Descriptions.Item>
        {detail.target.type === 'conditions' ? (
          <>
            <Descriptions.Item label="语言">{conditions?.locales?.join(', ') || '不限'}</Descriptions.Item>
            <Descriptions.Item label="注册区间">{conditions?.registeredAfter ? formatDateTime(conditions.registeredAfter) : '不限'} — {conditions?.registeredBefore ? formatDateTime(conditions.registeredBefore) : '不限'}</Descriptions.Item>
          </>
        ) : null}
      </Descriptions>
      <Typography.Title level={5}>多语言内容</Typography.Title>
      {detail.translations.map((translation) => (
        <Card key={translation.locale} size="small" title={locales.find((item) => item.value === translation.locale)?.label ?? translation.locale}>
          <Typography.Text strong>{translation.title}</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0, marginTop: 8, whiteSpace: 'pre-wrap' }}>{translation.body}</Typography.Paragraph>
        </Card>
      ))}
    </Space>
  );
}

function StatusTag({ status }: { status: CampaignStatus }) {
  return <Tag color={campaignStatus[status].color}>{campaignStatus[status].label}</Tag>;
}

function testResult(config?: ProviderConfig): string {
  if (!config?.lastTestStatus) return '未测试';
  return config.lastTestStatus === 'passed' ? '真实测试已通过' : '真实测试未通过';
}

function channelLabel(channel: Channel): string {
  return channel === 'in_app' ? '站内信' : '移动推送';
}

function optionalIso(value?: string): string | undefined {
  return value ? requiredIso(value) : undefined;
}

function requiredIso(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error('Invalid date');
  return date.toISOString();
}

function toLocalDateTime(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) {
    if (reason.status === 409) return `${reason.message}，请刷新后重试。`;
    return reason.message;
  }
  return fallback;
}
