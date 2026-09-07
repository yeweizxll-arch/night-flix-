import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_LOCALE_OPTIONS } from '@drama/contracts';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { canAdvanceTlsStatus } from './site-settings-ui';
import { TenantMediaUploadModal } from './TenantContentListPage';

interface SiteTheme {
  accentColor: string;
  colorMode: 'dark' | 'light' | 'system';
  primaryColor: string;
}

interface SiteSettingsRecord {
  defaultLocale: string;
  effectiveSiteEnabled: boolean;
  iconMediaAssetId?: string;
  logoMediaAssetId?: string;
  merchantName: string;
  platformSiteEnabled: boolean;
  siteName: string;
  tenantId: string;
  theme: SiteTheme;
  userSiteEnabled: boolean;
  version: number;
}

interface DomainRecord {
  createdAt: string;
  enabled: boolean;
  host: string;
  id: string;
  isPrimary: boolean;
  readOnly: boolean;
  tlsStatus: 'pending' | 'provisioning' | 'active' | 'failed' | 'disabled';
  type: 'custom' | 'subdomain';
  updatedAt: string;
  verification:
    | { status: 'verified'; verifiedAt: string }
    | {
        recordName: string;
        recordType: 'TXT';
        recordValue: string;
        status: 'pending';
      };
  version: number;
}

interface SettingsFormValue {
  accentColor: string;
  colorMode: SiteTheme['colorMode'];
  defaultLocale: string;
  iconMediaAssetId?: string;
  logoMediaAssetId?: string;
  primaryColor: string;
  siteName: string;
  userSiteEnabled: boolean;
}

interface SiteSettingsPanelProps {
  canManageDomains: boolean;
  canManageSettings: boolean;
  canManageSiteStatus?: boolean;
  canReadDomains: boolean;
  canReadSettings: boolean;
  createDomainKind: 'custom' | 'subdomain';
  description: string;
  domainsEndpoint: string;
  settingsEndpoint: string;
  siteStatusEndpoint?: string;
  siteStatusMode?: 'platform' | 'tenant';
  tlsStatusEndpoint?: (domainId: string) => string;
  title: string;
  verifyEndpoint?: (domainId: string) => string;
}

const localeOptions = APP_LOCALE_OPTIONS;

export function SiteSettingsPanel({
  canManageDomains,
  canManageSettings,
  canManageSiteStatus = canManageSettings,
  canReadDomains,
  canReadSettings,
  createDomainKind,
  description,
  domainsEndpoint,
  settingsEndpoint,
  siteStatusEndpoint,
  siteStatusMode = 'tenant',
  tlsStatusEndpoint,
  title,
  verifyEndpoint,
}: SiteSettingsPanelProps) {
  const { request } = useAuth();
  const [form] = Form.useForm<SettingsFormValue>();
  const [domainForm] = Form.useForm<{ value: string }>();
  const [messageApi, messageContext] = message.useMessage();
  const [settings, setSettings] = useState<SiteSettingsRecord>();
  const [domains, setDomains] = useState<DomainRecord[]>([]);
  const [settingsLoading, setSettingsLoading] = useState(canReadSettings);
  const [domainsLoading, setDomainsLoading] = useState(canReadDomains);
  const [settingsError, setSettingsError] = useState<string>();
  const [domainsError, setDomainsError] = useState<string>();
  const [failedVerification, setFailedVerification] = useState<DomainRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const [domainModalOpen, setDomainModalOpen] = useState(false);
  const [tlsTarget, setTlsTarget] = useState<DomainRecord>();
  const [tlsForm] = Form.useForm<{
    certificateReference: string;
    tlsStatus: 'active' | 'failed';
  }>();
  const settingsSequence = useRef(0);
  const domainsSequence = useRef(0);

  const loadSettings = useCallback(async () => {
    if (!canReadSettings) return;
    const sequence = ++settingsSequence.current;
    setSettingsLoading(true);
    setSettingsError(undefined);
    try {
      const result = await request<SiteSettingsRecord>(settingsEndpoint);
      if (sequence !== settingsSequence.current) return;
      setSettings(result);
      form.setFieldsValue({
        accentColor: result.theme.accentColor,
        colorMode: result.theme.colorMode,
        defaultLocale: result.defaultLocale,
        iconMediaAssetId: result.iconMediaAssetId,
        logoMediaAssetId: result.logoMediaAssetId,
        primaryColor: result.theme.primaryColor,
        siteName: result.siteName,
        userSiteEnabled: siteStatusMode === 'platform'
          ? result.platformSiteEnabled
          : result.userSiteEnabled,
      });
    } catch (reason) {
      if (sequence === settingsSequence.current) {
        setSettingsError(errorMessage(reason, '站点配置加载失败'));
      }
    } finally {
      if (sequence === settingsSequence.current) setSettingsLoading(false);
    }
  }, [canReadSettings, form, request, settingsEndpoint, siteStatusMode]);

  const loadDomains = useCallback(async () => {
    if (!canReadDomains) return;
    const sequence = ++domainsSequence.current;
    setDomainsLoading(true);
    setDomainsError(undefined);
    setFailedVerification(undefined);
    try {
      const result = await request<DomainRecord[]>(domainsEndpoint);
      if (sequence === domainsSequence.current) setDomains(result);
    } catch (reason) {
      if (sequence === domainsSequence.current) {
        setDomainsError(errorMessage(reason, '域名列表加载失败'));
      }
    } finally {
      if (sequence === domainsSequence.current) setDomainsLoading(false);
    }
  }, [canReadDomains, domainsEndpoint, request]);

  useEffect(() => {
    void loadSettings();
    void loadDomains();
  }, [loadDomains, loadSettings]);

  async function saveSettings(values: SettingsFormValue): Promise<void> {
    if (!settings) return;
    const brandingChanged =
      values.siteName.trim() !== settings.siteName ||
      optionalUuid(values.logoMediaAssetId) !== (settings.logoMediaAssetId ?? null) ||
      optionalUuid(values.iconMediaAssetId) !== (settings.iconMediaAssetId ?? null) ||
      values.defaultLocale !== settings.defaultLocale ||
      values.primaryColor.toLowerCase() !== settings.theme.primaryColor ||
      values.accentColor.toLowerCase() !== settings.theme.accentColor ||
      values.colorMode !== settings.theme.colorMode;
    const currentStatus = siteStatusMode === 'platform'
      ? settings.platformSiteEnabled
      : settings.userSiteEnabled;
    const statusChanged = values.userSiteEnabled !== currentStatus;
    if (!brandingChanged && !statusChanged) {
      messageApi.info('配置没有变化');
      return;
    }
    if (brandingChanged && !canManageSettings) {
      messageApi.error('当前账号没有修改白标配置的权限');
      return;
    }
    if (statusChanged && !canManageSiteStatus) {
      messageApi.error('当前账号没有切换用户站的权限');
      return;
    }
    setSubmitting('settings');
    try {
      let current = settings;
      if (brandingChanged || (!siteStatusEndpoint && statusChanged)) {
        const payload: Record<string, unknown> = {
          defaultLocale: values.defaultLocale,
          iconMediaAssetId: optionalUuid(values.iconMediaAssetId),
          logoMediaAssetId: optionalUuid(values.logoMediaAssetId),
          siteName: values.siteName.trim(),
          theme: {
            accentColor: values.accentColor.toLowerCase(),
            colorMode: values.colorMode,
            primaryColor: values.primaryColor.toLowerCase(),
          },
          version: current.version,
        };
        if (!siteStatusEndpoint) payload.userSiteEnabled = values.userSiteEnabled;
        current = await request<SiteSettingsRecord>(settingsEndpoint, {
          body: JSON.stringify(payload),
          method: 'PATCH',
        });
      }
      if (statusChanged && siteStatusEndpoint) {
        current = await request<SiteSettingsRecord>(siteStatusEndpoint, {
          body: JSON.stringify({
            [siteStatusMode === 'platform' ? 'platformSiteEnabled' : 'userSiteEnabled']:
              values.userSiteEnabled,
            version: current.version,
          }),
          method: 'PATCH',
        });
      }
      setSettings(current);
      messageApi.success('站点配置已更新');
      await loadSettings();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '站点配置更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function createDomain(values: { value: string }): Promise<void> {
    setSubmitting('create-domain');
    try {
      await request<DomainRecord>(
        createDomainKind === 'subdomain' ? `${domainsEndpoint}/subdomains` : domainsEndpoint,
        {
          body: JSON.stringify(
            createDomainKind === 'subdomain'
              ? { label: values.value.trim().toLowerCase() }
              : { host: values.value.trim() },
          ),
          method: 'POST',
        },
      );
      messageApi.success(createDomainKind === 'subdomain' ? '平台子域名已分配' : '域名已添加，请配置 TXT 记录');
      setDomainModalOpen(false);
      domainForm.resetFields();
      await loadDomains();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '域名添加失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function updateDomain(domain: DomainRecord, patch: { enabled?: boolean; isPrimary?: boolean }) {
    const action = `domain:${domain.id}`;
    setSubmitting(action);
    try {
      await request<DomainRecord>(`${domainsEndpoint}/${encodeURIComponent(domain.id)}`, {
        body: JSON.stringify({ ...patch, version: domain.version }),
        method: 'PATCH',
      });
      messageApi.success('域名配置已更新');
      await loadDomains();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '域名配置更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function verifyDomain(domain: DomainRecord) {
    if (!verifyEndpoint) return;
    const action = `verify:${domain.id}`;
    setSubmitting(action);
    setDomainsError(undefined);
    try {
      await request<DomainRecord>(verifyEndpoint(domain.id), {
        body: JSON.stringify({ version: domain.version }),
        method: 'POST',
      });
      messageApi.success('DNS 所有权验证通过，证书状态已进入处理中');
      await loadDomains();
    } catch (reason) {
      const text = errorMessage(reason, 'DNS TXT 验证未通过');
      setDomainsError(text);
      setFailedVerification(domain);
      messageApi.error(text);
    } finally {
      setSubmitting(undefined);
    }
  }

  async function setTlsStatus(values: {
    certificateReference: string;
    tlsStatus: 'active' | 'failed';
  }) {
    if (!tlsTarget || !tlsStatusEndpoint) return;
    setSubmitting(`tls:${tlsTarget.id}`);
    try {
      await request<DomainRecord>(tlsStatusEndpoint(tlsTarget.id), {
        body: JSON.stringify({
          certificateReference: values.certificateReference.trim(),
          tlsStatus: values.tlsStatus,
          version: tlsTarget.version,
        }),
        method: 'PATCH',
      });
      messageApi.success('证书状态已更新并写入审计日志');
      setTlsTarget(undefined);
      tlsForm.resetFields();
      await loadDomains();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '证书状态更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  const settingsTab = canReadSettings ? {
    children: settingsError ? (
      <Alert
        action={<Button size="small" onClick={() => void loadSettings()}>重试</Button>}
        message={settingsError}
        showIcon
        type="error"
      />
    ) : (
      <Card loading={settingsLoading}>
        {settings ? (
          <Alert
            className="page-alert"
            message={settings.effectiveSiteEnabled
              ? '用户站当前可访问'
              : siteStatusMode === 'platform'
                ? '用户站当前不可访问：平台开关或代理商开关已关闭'
                : settings.platformSiteEnabled
                  ? '用户站当前由代理商关闭'
                  : '用户站已被平台关闭，代理商无法自行恢复'}
            showIcon
            type={settings.effectiveSiteEnabled ? 'success' : 'warning'}
          />
        ) : null}
        <Form<SettingsFormValue>
          name="sitesettingspanel-1" disabled={submitting === 'settings'}
          form={form}
          layout="vertical"
          onFinish={(values) => void saveSettings(values)}
          requiredMark={false}
        >
          <Row gutter={16}>
            <Col md={12} xs={24}>
              <Form.Item label="站点名称" name="siteName" rules={[{ required: true }, { max: 200 }]}>
                <Input disabled={!canManageSettings} />
              </Form.Item>
            </Col>
            <Col md={12} xs={24}>
              <Form.Item label="默认语言" name="defaultLocale" rules={[{ required: true }]}>
                <Select disabled={!canManageSettings} options={localeOptions} />
              </Form.Item>
            </Col>
            <Col md={12} xs={24}>
              <Form.Item
                label="品牌 Logo"
                name="logoMediaAssetId"
              >
                <SiteImageField disabled={!canManageSettings} label="品牌 Logo" tenant={siteStatusMode === 'tenant'} />
              </Form.Item>
            </Col>
            <Col md={12} xs={24}>
              <Form.Item label="站点图标" name="iconMediaAssetId">
                <SiteImageField disabled={!canManageSettings} label="站点图标" tenant={siteStatusMode === 'tenant'} />
              </Form.Item>
            </Col>
            <Col md={8} xs={24}>
              <Form.Item label="主色" name="primaryColor" rules={[{ pattern: /^#[0-9a-fA-F]{6}$/, required: true }]}>
                <Input disabled={!canManageSettings} placeholder="#2563eb" />
              </Form.Item>
            </Col>
            <Col md={8} xs={24}>
              <Form.Item label="强调色" name="accentColor" rules={[{ pattern: /^#[0-9a-fA-F]{6}$/, required: true }]}>
                <Input disabled={!canManageSettings} placeholder="#7c3aed" />
              </Form.Item>
            </Col>
            <Col md={8} xs={24}>
              <Form.Item label="色彩模式" name="colorMode" rules={[{ required: true }]}>
                <Select disabled={!canManageSettings} options={[
                  { label: '浅色', value: 'light' },
                  { label: '深色', value: 'dark' },
                  { label: '跟随系统', value: 'system' },
                ]} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label={siteStatusMode === 'platform' ? 'SaaS 服务接入' : '代理商用户站开关'}
                name="userSiteEnabled"
                valuePropName="checked"
              >
                <Switch disabled={!canManageSiteStatus} checkedChildren="启用" unCheckedChildren="关闭" />
              </Form.Item>
            </Col>
          </Row>
          {(canManageSettings || canManageSiteStatus) ? (
            <Button htmlType="submit" loading={submitting === 'settings'} type="primary">
              保存配置
            </Button>
          ) : <Typography.Text type="secondary">当前账号为只读权限。</Typography.Text>}
        </Form>
      </Card>
    ),
    key: 'settings',
    label: '白标与站点',
  } : undefined;

  const domainTab = canReadDomains ? {
    children: (
      <>
        {domainsError ? (
          <Alert
            action={<Button size="small" onClick={() => void (failedVerification ? verifyDomain(failedVerification) : loadDomains())}>重试</Button>}
            className="page-alert"
            message={domainsError}
            showIcon
            type="error"
          />
        ) : null}
        <div className="tenant-content-toolbar">
          <Button loading={domainsLoading} onClick={() => void loadDomains()}>刷新域名</Button>
          {canManageDomains ? (
            <Button type="primary" onClick={() => setDomainModalOpen(true)}>
              {createDomainKind === 'subdomain' ? '分配子域名' : '绑定独立域名'}
            </Button>
          ) : null}
        </div>
        <Table<DomainRecord>
          dataSource={domains}
          loading={domainsLoading}
          locale={{ emptyText: <Empty description="暂无域名" /> }}
          pagination={false}
          rowKey="id"
          columns={[
            {
              dataIndex: 'host',
              title: '域名',
              render: (host: string, domain) => (
                <Space direction="vertical" size={2}>
                  <Space size={6} wrap>
                    <Typography.Text copyable strong>{host}</Typography.Text>
                    <Tag>{domain.type === 'subdomain' ? '平台子域名' : '独立域名'}</Tag>
                    {domain.isPrimary ? <Tag color="blue">主域名</Tag> : null}
                    {domain.readOnly ? <Tag>只读</Tag> : null}
                  </Space>
                  {domain.verification.status === 'pending' ? (
                    <Typography.Text type="secondary">
                      TXT <Typography.Text copyable code>{domain.verification.recordName}</Typography.Text>
                      {' = '}
                      <Typography.Text copyable code>{domain.verification.recordValue}</Typography.Text>
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              key: 'verification',
              title: '所有权',
              width: 110,
              render: (_: unknown, domain) => domain.verification.status === 'verified'
                ? <Tag color="green">已验证</Tag>
                : <Tag color="orange">待验证</Tag>,
            },
            {
              dataIndex: 'tlsStatus',
              title: '证书',
              width: 115,
              render: (status: DomainRecord['tlsStatus']) => <Tag>{tlsLabel(status)}</Tag>,
            },
            {
              key: 'enabled',
              title: '解析',
              width: 90,
              render: (_: unknown, domain) => domain.enabled
                ? <Tag color="green">启用</Tag>
                : <Tag>停用</Tag>,
            },
            {
              key: 'actions',
              title: '操作',
              width: 250,
              render: (_: unknown, domain) => {
                if (!canManageDomains || domain.readOnly) return <Typography.Text type="secondary">只读</Typography.Text>;
                const busy = submitting?.endsWith(domain.id) ?? false;
                return (
                  <Space size={6} wrap>
                    {verifyEndpoint && domain.verification.status === 'pending' ? (
                      <Button loading={submitting === `verify:${domain.id}`} size="small" onClick={() => void verifyDomain(domain)}>
                        验证 DNS
                      </Button>
                    ) : null}
                    {canAdvanceTlsStatus(domain, Boolean(tlsStatusEndpoint)) ? (
                      <Button disabled={busy} size="small" onClick={() => {
                        tlsForm.setFieldsValue({
                          certificateReference: '',
                          tlsStatus: domain.tlsStatus === 'failed' ? 'failed' : 'active',
                        });
                        setTlsTarget(domain);
                      }}>
                        证书状态
                      </Button>
                    ) : null}
                    {!domain.isPrimary && domain.enabled && domain.verification.status === 'verified' && domain.tlsStatus === 'active' ? (
                      <Popconfirm title="将此域名设为主域名？" onConfirm={() => void updateDomain(domain, { isPrimary: true })}>
                        <Button disabled={busy} size="small">设为主域名</Button>
                      </Popconfirm>
                    ) : null}
                    {!domain.isPrimary && domain.enabled && domain.verification.status === 'verified' && domain.tlsStatus !== 'active'
                      ? <Typography.Text type="secondary">证书生效后可设为主域名</Typography.Text> : null}
                    {!domain.isPrimary ? (
                      <Popconfirm
                        title={domain.enabled ? '停用此域名？' : '重新启用此域名？'}
                        onConfirm={() => void updateDomain(domain, { enabled: !domain.enabled })}
                      >
                        <Button disabled={busy} size="small">{domain.enabled ? '停用' : '启用'}</Button>
                      </Popconfirm>
                    ) : null}
                  </Space>
                );
              },
            },
          ]}
        />
      </>
    ),
    key: 'domains',
    label: '域名管理',
  } : undefined;

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </div>
      </div>
      <Tabs items={[settingsTab, domainTab].filter(Boolean) as NonNullable<typeof settingsTab>[]} />
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setDomainModalOpen(false)}
        open={domainModalOpen}
        title={createDomainKind === 'subdomain' ? '分配平台子域名' : '绑定独立域名'}
      >
        <Alert
          className="page-alert"
          message={createDomainKind === 'subdomain'
            ? '仅填写前缀，服务端会拼接平台租户根域名。'
            : '添加后，请按提示配置 DNS TXT 记录，再点击验证。'}
          showIcon
          type="info"
        />
        <Form name="sitesettingspanel-2" form={domainForm} layout="vertical" onFinish={(values) => void createDomain(values)}>
          <Form.Item
            label={createDomainKind === 'subdomain' ? '子域名前缀' : '独立域名'}
            name="value"
            rules={[{ required: true }]}
          >
            <Input placeholder={createDomainKind === 'subdomain' ? 'shop-jp' : 'video.example.com'} />
          </Form.Item>
          <Button block htmlType="submit" loading={submitting === 'create-domain'} type="primary">
            确认
          </Button>
        </Form>
      </Modal>
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setTlsTarget(undefined)}
        open={Boolean(tlsTarget)}
        title="推进域名证书状态"
      >
        <Alert
          className="page-alert"
          message="只有确认反向代理或证书平台已实际完成配置后，才能标记为已生效。操作会记录证书工单/部署引用和审计日志。"
          showIcon
          type="warning"
        />
        <Form name="sitesettingspanel-3" form={tlsForm} layout="vertical" onFinish={(values) => void setTlsStatus(values)}>
          <Form.Item label="状态" name="tlsStatus" rules={[{ required: true }]}>
            <Select options={[
              { label: '已生效', value: 'active' },
              { label: '配置失败', value: 'failed' },
            ]} />
          </Form.Item>
          <Form.Item
            extra="填写证书平台工单号或部署记录引用，不要粘贴私钥、证书正文或访问密钥。"
            label="证书/部署引用"
            name="certificateReference"
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/, message: '仅限安全的工单号或路径引用' },
            ]}
          >
            <Input maxLength={200} placeholder="cert-job/2026-001" />
          </Form.Item>
          <Button block htmlType="submit" loading={Boolean(tlsTarget && submitting === `tls:${tlsTarget.id}`)} type="primary">
            确认状态
          </Button>
        </Form>
      </Modal>
    </>
  );
}

function SiteImageField({ value, onChange, disabled, label, tenant, id }: {
  value?: string; onChange?(value?: string): void; disabled: boolean; label: string; tenant: boolean; id?: string;
}) {
  const { principal } = useAuth();
  const [uploading, setUploading] = useState(false);
  if (!tenant) return <Input id={id} disabled={disabled} value={value} onChange={event => onChange?.(event.target.value)} placeholder="代理商提供的图片编号（可选）" allowClear />;
  const canUpload = principal?.permissions.includes('content.drama.create');
  return <><Space wrap>
    <Typography.Text type="secondary">{value ? '已关联图片' : '未设置图片'}</Typography.Text>
    {canUpload && <Button id={id} disabled={disabled} onClick={() => setUploading(true)}>{value ? `更换${label}` : `上传${label}`}</Button>}
    {value && <Button disabled={disabled} onClick={() => onChange?.(undefined)}>清除{label}</Button>}
    {!canUpload && <Typography.Text type="secondary">上传图片需要内容创建权限</Typography.Text>}
  </Space>
    <TenantMediaUploadModal kind="image" open={uploading} title={`上传${label}`} onCancel={() => setUploading(false)}
      onReady={mediaId => { onChange?.(mediaId); setUploading(false); }} />
  </>;
}

function optionalUuid(value: string | undefined): string | null {
  return value?.trim() || null;
}

function tlsLabel(status: DomainRecord['tlsStatus']): string {
  return ({
    active: '已生效',
    disabled: '已停用',
    failed: '失败',
    pending: '待处理',
    provisioning: '处理中',
  } as const)[status];
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
