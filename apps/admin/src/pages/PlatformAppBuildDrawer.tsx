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
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import type { AuthPrincipal } from '../auth/AuthProvider';
import { useAuth } from '../auth/AuthProvider';
import {
  appBuildBase,
  buildStatusLabels,
  buildTargetLabels,
  eligibleBuildDomains,
  eligibleIconAssets,
  eligibleLaunchAssets,
  formatBuildBytes,
  validateAppBuildAssetCompletion,
  validateAppBuildAssetFile,
  validateSecureBuildDownload,
  type AppBuildAssetCompletion,
  type AppBuildAssetPurpose,
  type AppBuildDownloadResponse,
  type AppBuildStatus,
  type AppBuildTarget,
} from './app-build-ui';
import {
  contentUploadHeaders,
  validateContentUploadIntent,
  type ContentUploadIntent,
} from './content-upload-ui';
import { sha256Blob } from './file-sha256';

interface MerchantSummary {
  id: string;
  name: string;
}

interface BuildDomain {
  eligible: boolean;
  host: string;
  id: string;
  isPrimary: boolean;
  reasons: string[];
  tlsStatus: string;
  type: string;
  version: number;
}

interface BuildAsset {
  buildReady: true;
  checksum: string;
  createdAt: string;
  height: number | string;
  iconCandidate: boolean;
  id: string;
  mimeType: string;
  purpose: AppBuildAssetPurpose;
  sizeBytes: string;
  width: number | string;
}

interface BuildAssetProvider {
  id: string;
  label: string;
  ownerType: 'platform' | 'tenant';
}

interface BuildPrerequisites {
  assetProviders: BuildAssetProvider[];
  assets: { hasMore: boolean; items: BuildAsset[] };
  domains: BuildDomain[];
  effectiveSiteEnabled: boolean;
  siteName: string;
  siteSettingsVersion: number;
  targets: {
    androidDebug: { available: boolean };
    androidStore: { available: false; reason: 'signing_not_configured' };
    iosSimulator: { available: boolean };
    iosStore: { available: false; reason: 'signing_not_configured' };
  };
  tenantId: string;
}

interface AppBuildProfile {
  androidApplicationId: string;
  appName: string;
  createdAt: string;
  h5DomainId: string;
  h5Host: string;
  iconMediaAssetId: string;
  id: string;
  iosBundleId: string;
  splashMediaAssetId?: string;
  tenantId: string;
  updatedAt: string;
  version: number;
}

interface AppBuildJob {
  artifact?: {
    contentType: 'application/vnd.android.package-archive' | 'application/zip';
    filename: string;
    sizeBytes: string;
  };
  completedAt?: string;
  createdAt: string;
  failureCode?: string;
  id: string;
  profileId: string;
  profileVersion: number;
  releaseChannel: 'internal_test';
  startedAt?: string;
  status: AppBuildStatus;
  target: AppBuildTarget;
  tenantId: string;
  version: number;
}

interface JobsResponse {
  items: AppBuildJob[];
  page: number;
  pageSize: number;
  total: number;
}

interface ProfileFormValue {
  androidApplicationId: string;
  appName: string;
  h5DomainId: string;
  iconMediaAssetId: string;
  iosBundleId: string;
  splashMediaAssetId?: string;
}

interface Props {
  merchant?: MerchantSummary;
  onClose(): void;
  principal?: AuthPrincipal;
}

const failureLabels: Record<string, string> = {
  artifact_upload_failed: '构建产物保存失败',
  asset_unavailable: '图标或启动图当前不可用',
  builder_unavailable: '构建服务暂不可用',
  build_failed: '构建失败',
  job_timed_out: '构建超时',
};

const reasonLabels: Record<string, string> = {
  disabled: '域名未启用',
  not_verified: '域名未验证',
  tls_not_active: 'TLS 证书未生效',
};

const statusColors: Record<AppBuildStatus, string> = {
  cancelled: 'default',
  failed: 'red',
  processing: 'blue',
  queued: 'gold',
  succeeded: 'green',
};

export function PlatformAppBuildDrawer({ merchant, onClose, principal }: Props) {
  const { request } = useAuth();
  const [form] = Form.useForm<ProfileFormValue>();
  const [messageApi, messageContext] = message.useMessage();
  const [prerequisites, setPrerequisites] = useState<BuildPrerequisites>();
  const [profile, setProfile] = useState<AppBuildProfile>();
  const [jobs, setJobs] = useState<JobsResponse>({ items: [], page: 1, pageSize: 20, total: 0 });
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string>();
  const [jobsError, setJobsError] = useState<string>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<AppBuildStatus>();
  const [targetFilter, setTargetFilter] = useState<AppBuildTarget>();
  const [jobDetail, setJobDetail] = useState<AppBuildJob>();
  const [uploadPurpose, setUploadPurpose] = useState<AppBuildAssetPurpose>();
  const [detailLoading, setDetailLoading] = useState(false);
  const overviewSequence = useRef(0);
  const jobsSequence = useRef(0);
  const detailSequence = useRef(0);
  const base = useMemo(() => merchant ? appBuildBase(merchant.id) : undefined, [merchant]);
  const canManage = principal?.permissions.includes('platform.app_build.manage') ?? false;
  const canDownload = principal?.permissions.includes('platform.app_build.download') ?? false;

  const loadOverview = useCallback(async () => {
    if (!base) return;
    const sequence = ++overviewSequence.current;
    setOverviewLoading(true);
    setOverviewError(undefined);
    try {
      const [nextPrerequisites, profileResponse] = await Promise.all([
        request<BuildPrerequisites>(`${base}/prerequisites`),
        request<{ profile: AppBuildProfile | null }>(`${base}/profile`),
      ]);
      if (sequence !== overviewSequence.current) return;
      setPrerequisites(nextPrerequisites);
      const nextProfile = profileResponse.profile ?? undefined;
      setProfile(nextProfile);
      form.setFieldsValue(nextProfile ? {
        androidApplicationId: nextProfile.androidApplicationId,
        appName: nextProfile.appName,
        h5DomainId: nextProfile.h5DomainId,
        iconMediaAssetId: nextProfile.iconMediaAssetId,
        iosBundleId: nextProfile.iosBundleId,
        splashMediaAssetId: nextProfile.splashMediaAssetId,
      } : {
        androidApplicationId: undefined,
        appName: nextPrerequisites.siteName,
        h5DomainId: undefined,
        iconMediaAssetId: undefined,
        iosBundleId: undefined,
        splashMediaAssetId: undefined,
      });
    } catch (reason) {
      if (sequence === overviewSequence.current) {
        setOverviewError(errorText(reason, '应用构建配置加载失败'));
      }
    } finally {
      if (sequence === overviewSequence.current) setOverviewLoading(false);
    }
  }, [base, form, request]);

  const loadJobs = useCallback(async (
    page = 1,
    pageSize = 20,
    options: { silent?: boolean } = {},
  ) => {
    if (!base) return;
    const sequence = ++jobsSequence.current;
    if (!options.silent) setJobsLoading(true);
    setJobsError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (statusFilter) query.set('status', statusFilter);
    if (targetFilter) query.set('target', targetFilter);
    try {
      const result = await request<JobsResponse>(`${base}/jobs?${query.toString()}`);
      if (sequence === jobsSequence.current) setJobs(result);
    } catch (reason) {
      if (sequence === jobsSequence.current) setJobsError(errorText(reason, '构建任务加载失败'));
    } finally {
      if (sequence === jobsSequence.current && !options.silent) setJobsLoading(false);
    }
  }, [base, request, statusFilter, targetFilter]);

  const loadJobDetail = useCallback(async (jobId: string, silent = false) => {
    if (!base) return;
    const sequence = ++detailSequence.current;
    if (!silent) setDetailLoading(true);
    try {
      const result = await request<AppBuildJob>(`${base}/jobs/${encodeURIComponent(jobId)}`);
      if (sequence === detailSequence.current) setJobDetail(result);
    } catch (reason) {
      if (sequence === detailSequence.current) messageApi.error(errorText(reason, '任务详情加载失败'));
    } finally {
      if (sequence === detailSequence.current && !silent) setDetailLoading(false);
    }
  }, [base, messageApi, request]);

  useEffect(() => {
    if (!merchant) return;
    setPrerequisites(undefined);
    setProfile(undefined);
    setJobDetail(undefined);
    setUploadPurpose(undefined);
    setJobs({ items: [], page: 1, pageSize: 20, total: 0 });
    setStatusFilter(undefined);
    setTargetFilter(undefined);
    form.resetFields();
    void loadOverview();
    void loadJobs();
    return () => {
      overviewSequence.current += 1;
      jobsSequence.current += 1;
      detailSequence.current += 1;
    };
  // A filter change must not reset the whole merchant drawer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant?.id]);

  useEffect(() => {
    if (!merchant) return;
    void loadJobs(1, jobs.pageSize);
  // Filters intentionally restart pagination; pageSize is retained.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, targetFilter]);

  const visibleJobIsActive = jobs.items.some((job) => job.status === 'queued' || job.status === 'processing');
  useEffect(() => {
    if (!merchant || !visibleJobIsActive) return;
    const timer = window.setInterval(() => void loadJobs(jobs.page, jobs.pageSize, { silent: true }), 4_000);
    return () => window.clearInterval(timer);
  }, [jobs.page, jobs.pageSize, loadJobs, merchant, visibleJobIsActive]);

  useEffect(() => {
    if (!jobDetail || (jobDetail.status !== 'queued' && jobDetail.status !== 'processing')) return;
    const timer = window.setInterval(() => void loadJobDetail(jobDetail.id, true), 4_000);
    return () => window.clearInterval(timer);
  }, [jobDetail, loadJobDetail]);

  async function saveProfile(values: ProfileFormValue): Promise<void> {
    if (!base) return;
    setSavingProfile(true);
    try {
      const result = await request<AppBuildProfile>(`${base}/profile`, {
        body: JSON.stringify({
          ...values,
          expectedVersion: profile?.version ?? null,
          splashMediaAssetId: values.splashMediaAssetId || null,
        }),
        method: 'PUT',
      });
      setProfile(result);
      messageApi.success('构建资料已保存');
      await loadOverview();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        messageApi.warning('资料已被其他人修改，已刷新最新版本');
        await loadOverview();
      } else {
        messageApi.error(errorText(reason, '构建资料保存失败'));
      }
    } finally {
      setSavingProfile(false);
    }
  }

  async function createJob(target: AppBuildTarget): Promise<void> {
    if (!base || !profile) return;
    setBusyAction(`create:${target}`);
    try {
      const result = await request<AppBuildJob>(`${base}/jobs`, {
        body: JSON.stringify({ expectedProfileVersion: profile.version, target }),
        method: 'POST',
      });
      messageApi.success('构建任务已进入队列');
      await loadJobs(1, jobs.pageSize);
      setJobDetail(result);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        messageApi.warning('构建资料版本已变化，已刷新，请重新确认');
        await loadOverview();
      } else {
        messageApi.error(errorText(reason, '构建任务创建失败'));
      }
    } finally {
      setBusyAction(undefined);
    }
  }

  async function cancelJob(job: AppBuildJob): Promise<void> {
    if (!base || job.status !== 'queued') return;
    setBusyAction(`cancel:${job.id}`);
    try {
      const result = await request<AppBuildJob>(`${base}/jobs/${encodeURIComponent(job.id)}/cancel`, {
        body: JSON.stringify({ expectedVersion: job.version }),
        method: 'POST',
      });
      messageApi.success('排队任务已取消');
      if (jobDetail?.id === job.id) setJobDetail(result);
      await loadJobs(jobs.page, jobs.pageSize);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        messageApi.warning('任务状态已变化，已刷新');
        await Promise.all([
          loadJobs(jobs.page, jobs.pageSize),
          jobDetail?.id === job.id ? loadJobDetail(job.id) : Promise.resolve(),
        ]);
      } else {
        messageApi.error(errorText(reason, '任务取消失败'));
      }
    } finally {
      setBusyAction(undefined);
    }
  }

  async function downloadJob(job: AppBuildJob): Promise<void> {
    if (!base || job.status !== 'succeeded') return;
    setBusyAction(`download:${job.id}`);
    try {
      const result = await request<AppBuildDownloadResponse>(
        `${base}/jobs/${encodeURIComponent(job.id)}/download`,
        { method: 'POST' },
      );
      const safeUrl = validateSecureBuildDownload(result);
      window.open(safeUrl, '_blank', 'noopener,noreferrer');
      messageApi.success('已打开短时下载链接');
    } catch (reason) {
      messageApi.error(errorText(reason, '构建产物下载失败'));
    } finally {
      setBusyAction(undefined);
    }
  }

  function closeDrawer(): void {
    overviewSequence.current += 1;
    jobsSequence.current += 1;
    detailSequence.current += 1;
    setJobDetail(undefined);
    setUploadPurpose(undefined);
    form.resetFields();
    onClose();
  }

  const eligibleDomains = prerequisites ? eligibleBuildDomains(prerequisites.domains) : [];
  const iconAssets = prerequisites ? eligibleIconAssets(prerequisites.assets.items) : [];
  const launchAssets = prerequisites ? eligibleLaunchAssets(prerequisites.assets.items) : [];
  const configurationReady = Boolean(
    prerequisites?.effectiveSiteEnabled && eligibleDomains.length > 0 && iconAssets.length > 0,
  );

  return (
    <Drawer
      destroyOnHidden
      onClose={closeDrawer}
      open={Boolean(merchant)}
      title={merchant ? `${merchant.name} · 应用构建` : '应用构建'}
      width={1080}
    >
      {messageContext}
      {overviewError ? (
        <Alert
          action={<Button onClick={() => void loadOverview()} size="small">重试</Button>}
          message={overviewError}
          showIcon
          type="error"
        />
      ) : null}
      <Alert
        className="page-alert"
        message="当前只提供内部测试构建：Android 调试 APK 与 iOS 模拟器包。正式签名、Android AAB、iOS 真机、TestFlight 和 App Store 尚未配置。"
        showIcon
        type="info"
      />

      <Typography.Title level={4}>构建资料</Typography.Title>
      {!overviewLoading && prerequisites && !configurationReady ? (
        <Alert
          className="page-alert"
          description="请先启用代理商客户站、完成 HTTPS 域名验证，并上传 1024×1024、不含透明区域的 PNG 应用图标。"
          message="构建前置条件尚未满足"
          showIcon
          type="warning"
        />
      ) : null}
      {prerequisites?.assets.hasMore ? (
        <Alert className="page-alert" message="仅显示最近 100 个已核验的构建专用资产；更早资源请重新上传后再选择。" type="warning" />
      ) : null}
      {prerequisites && prerequisites.assetProviders.length === 0 ? (
        <Alert
          className="page-alert"
          message="暂无可用对象存储，请先配置代理商存储或启用公共存储。"
          showIcon
          type="warning"
        />
      ) : null}
      <Form<ProfileFormValue>
        name="platformappbuilddrawer-1" disabled={!canManage || overviewLoading}
        form={form}
        layout="vertical"
        onFinish={(values) => void saveProfile(values)}
        requiredMark={false}
      >
        <div className="two-column-form">
          <Form.Item label="应用名称" name="appName" rules={[{ required: true }, { min: 2, max: 50 }]}>
            <Input maxLength={50} />
          </Form.Item>
          <Form.Item
            extra="例如 com.example.drama；创建构建任务前请确认不会与其他代理商冲突。"
            label="Android Application ID"
            name="androidApplicationId"
            rules={[
              { required: true },
              { pattern: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, message: '请输入合法的 Android Application ID' },
            ]}
          >
            <Input maxLength={150} placeholder="com.example.drama" />
          </Form.Item>
          <Form.Item
            extra="例如 com.example.drama。"
            label="iOS Bundle ID"
            name="iosBundleId"
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/, message: '请输入合法的 iOS Bundle ID' },
            ]}
          >
            <Input maxLength={200} placeholder="com.example.drama" />
          </Form.Item>
          <Form.Item label="App 服务域名" name="h5DomainId" rules={[{ required: true }]}>
            <Select
              options={eligibleDomains.map((domain) => ({
                label: `${domain.host}${domain.isPrimary ? '（主域名）' : ''}`,
                value: domain.id,
              }))}
              placeholder="仅可选择已验证、启用且 TLS 生效的域名"
            />
          </Form.Item>
          <Form.Item label="应用图标" name="iconMediaAssetId" rules={[{ required: true }]}>
            <Space.Compact block>
              <Select
                optionFilterProp="label"
                options={iconAssets.map((asset) => ({
                  label: `${asset.id} · ${asset.width}×${asset.height} · ${formatBuildBytes(asset.sizeBytes)}`,
                  value: asset.id,
                }))}
                placeholder="仅可选择已核验的 1024×1024 无透明 PNG"
                showSearch
              />
              <Button
                disabled={!canManage || !prerequisites?.assetProviders.length}
                onClick={() => setUploadPurpose('app_icon')}
              >
                上传专用图标
              </Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item extra="可留空；请选择已上传并通过校验的启动图。" label="启动图" name="splashMediaAssetId">
            <Space.Compact block>
              <Select
                allowClear
                optionFilterProp="label"
                options={launchAssets.map((asset) => ({
                  label: `${asset.id} · ${asset.width}×${asset.height} · ${asset.mimeType} · ${formatBuildBytes(asset.sizeBytes)}`,
                  value: asset.id,
                }))}
                placeholder="不配置启动图"
                showSearch
              />
              <Button
                disabled={!canManage || !prerequisites?.assetProviders.length}
                onClick={() => setUploadPurpose('launch_image')}
              >
                上传专用启动图
              </Button>
            </Space.Compact>
          </Form.Item>
        </div>
        {canManage ? (
          <Button htmlType="submit" loading={savingProfile} type="primary">保存构建资料</Button>
        ) : <Typography.Text type="secondary">当前账号只有查看权限。</Typography.Text>}
        {profile ? <Typography.Text type="secondary">　当前资料版本：v{profile.version}</Typography.Text> : null}
      </Form>

      {prerequisites?.domains.some((domain) => !domain.eligible) ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          未满足条件的域名：{prerequisites.domains.filter((domain) => !domain.eligible).map((domain) =>
            `${domain.host}（${domain.reasons.map((reason) => reasonLabels[reason] ?? '不可用').join('、')}）`,
          ).join('；')}
        </Typography.Paragraph>
      ) : null}

      <Typography.Title level={4}>创建内部测试包</Typography.Title>
      <Space align="start" wrap>
        <BuildTargetCard
          available={Boolean(prerequisites?.targets.androidDebug.available && profile)}
          busy={busyAction === 'create:android_debug'}
          canManage={canManage}
          onCreate={() => void createJob('android_debug')}
          title="Android 调试 APK"
        />
        <BuildTargetCard
          available={Boolean(prerequisites?.targets.iosSimulator.available && profile)}
          busy={busyAction === 'create:ios_simulator'}
          canManage={canManage}
          onCreate={() => void createJob('ios_simulator')}
          title="iOS 模拟器包"
        />
        <UnavailableTarget title="Android AAB / Google Play" />
        <UnavailableTarget title="iOS 真机 / TestFlight / App Store" />
      </Space>

      <div className="page-heading" style={{ marginTop: 28 }}>
        <Typography.Title level={4}>构建任务</Typography.Title>
        <Space wrap>
          <Select<AppBuildStatus>
            allowClear
            onChange={setStatusFilter}
            options={Object.entries(buildStatusLabels).map(([value, label]) => ({ label, value: value as AppBuildStatus }))}
            placeholder="全部状态"
            style={{ width: 130 }}
            value={statusFilter}
          />
          <Select<AppBuildTarget>
            allowClear
            onChange={setTargetFilter}
            options={Object.entries(buildTargetLabels).map(([value, label]) => ({ label, value: value as AppBuildTarget }))}
            placeholder="全部目标"
            style={{ width: 160 }}
            value={targetFilter}
          />
          <Button onClick={() => void loadJobs(jobs.page, jobs.pageSize)}>刷新</Button>
        </Space>
      </div>
      {jobsError ? (
        <Alert
          action={<Button onClick={() => void loadJobs(jobs.page, jobs.pageSize)} size="small">重试</Button>}
          className="page-alert"
          message={jobsError}
          showIcon
          type="error"
        />
      ) : null}
      <Table<AppBuildJob>
        dataSource={jobs.items}
        loading={jobsLoading}
        locale={{ emptyText: <Empty description="暂无构建任务" /> }}
        pagination={{
          current: jobs.page,
          onChange: (page, pageSize) => void loadJobs(page, pageSize),
          pageSize: jobs.pageSize,
          showSizeChanger: true,
          total: jobs.total,
        }}
        rowKey="id"
        columns={[
          {
            dataIndex: 'target',
            title: '构建目标',
            render: (target: AppBuildTarget) => buildTargetLabels[target],
          },
          {
            dataIndex: 'status',
            title: '状态',
            render: (status: AppBuildStatus) => <Tag color={statusColors[status]}>{buildStatusLabels[status]}</Tag>,
          },
          { dataIndex: 'profileVersion', title: '资料版本', render: (value: number) => `v${value}` },
          { dataIndex: 'createdAt', title: '创建时间', render: dateTime },
          {
            key: 'artifact',
            title: '产物',
            render: (_: unknown, row) => row.artifact
              ? `${row.artifact.filename} · ${formatBuildBytes(row.artifact.sizeBytes)}`
              : '—',
          },
          {
            key: 'actions',
            title: '操作',
            width: 220,
            render: (_: unknown, row) => (
              <Space wrap>
                <Button size="small" onClick={() => void loadJobDetail(row.id)}>详情</Button>
                {canManage && row.status === 'queued' ? (
                  <Popconfirm title="取消这个排队中的构建任务？" onConfirm={() => void cancelJob(row)}>
                    <Button danger loading={busyAction === `cancel:${row.id}`} size="small">取消</Button>
                  </Popconfirm>
                ) : null}
                {canDownload && row.status === 'succeeded' && row.artifact ? (
                  <Button loading={busyAction === `download:${row.id}`} size="small" onClick={() => void downloadJob(row)}>
                    下载
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        destroyOnHidden
        footer={null}
        loading={detailLoading}
        onCancel={() => {
          detailSequence.current += 1;
          setJobDetail(undefined);
        }}
        open={Boolean(jobDetail) || detailLoading}
        title="构建任务详情"
      >
        {jobDetail ? (
          <Descriptions column={1} size="small">
            <Descriptions.Item label="任务 ID"><Typography.Text copyable>{jobDetail.id}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="目标">{buildTargetLabels[jobDetail.target]}</Descriptions.Item>
            <Descriptions.Item label="发布通道">内部测试</Descriptions.Item>
            <Descriptions.Item label="状态"><Tag color={statusColors[jobDetail.status]}>{buildStatusLabels[jobDetail.status]}</Tag></Descriptions.Item>
            <Descriptions.Item label="资料版本">v{jobDetail.profileVersion}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{dateTime(jobDetail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="开始时间">{dateTime(jobDetail.startedAt)}</Descriptions.Item>
            <Descriptions.Item label="完成时间">{dateTime(jobDetail.completedAt)}</Descriptions.Item>
            {jobDetail.failureCode ? (
              <Descriptions.Item label="失败原因">{failureLabels[jobDetail.failureCode] ?? '构建未完成，请联系管理员查看安全审计记录'}</Descriptions.Item>
            ) : null}
            {jobDetail.artifact ? (
              <Descriptions.Item label="构建产物">
                {jobDetail.artifact.filename} · {formatBuildBytes(jobDetail.artifact.sizeBytes)}
              </Descriptions.Item>
            ) : null}
          </Descriptions>
        ) : null}
      </Modal>

      <AppBuildAssetUploadModal
        base={base}
        onCancel={() => setUploadPurpose(undefined)}
        onReady={async (mediaId) => {
          const purpose = uploadPurpose;
          await loadOverview();
          if (purpose === 'app_icon') form.setFieldValue('iconMediaAssetId', mediaId);
          if (purpose === 'launch_image') form.setFieldValue('splashMediaAssetId', mediaId);
          setUploadPurpose(undefined);
          messageApi.success(purpose === 'app_icon'
            ? '专用图标已核验，可保存到构建资料'
            : '专用启动图已核验，可保存到构建资料');
        }}
        open={Boolean(uploadPurpose)}
        providers={prerequisites?.assetProviders ?? []}
        purpose={uploadPurpose}
      />
    </Drawer>
  );
}

function AppBuildAssetUploadModal({
  base,
  onCancel,
  onReady,
  open,
  providers,
  purpose,
}: {
  base?: string;
  onCancel(): void;
  onReady(mediaId: string): Promise<void>;
  open: boolean;
  providers: BuildAssetProvider[];
  purpose?: AppBuildAssetPurpose;
}) {
  const { request } = useAuth();
  const [providerId, setProviderId] = useState('');
  const [file, setFile] = useState<File>();
  const [fileInputKey, setFileInputKey] = useState(0);
  const [stage, setStage] = useState<string>();
  const [hashProgress, setHashProgress] = useState(0);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setProviderId(providers[0]?.id ?? '');
    setFile(undefined);
    setFileInputKey((value) => value + 1);
    setStage(undefined);
    setHashProgress(0);
    setError(undefined);
  // The provider list is already present before an upload button can be opened.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function clearFile(): void {
    setFile(undefined);
    setFileInputKey((value) => value + 1);
  }

  function cancel(): void {
    abortRef.current?.abort();
    abortRef.current = undefined;
    clearFile();
    setStage(undefined);
    setHashProgress(0);
    setError(undefined);
    onCancel();
  }

  function selectFile(candidate?: File): void {
    setError(undefined);
    if (!candidate || !purpose) {
      clearFile();
      return;
    }
    const validation = validateAppBuildAssetFile(candidate, purpose);
    if (validation) {
      setError(validation);
      clearFile();
      return;
    }
    setFile(candidate);
  }

  async function upload(): Promise<void> {
    if (!base || !purpose || !file || !isUuidValue(providerId)) {
      setError(!file ? '请选择符合要求的图片文件' : '请选择可用对象存储');
      clearFile();
      return;
    }
    const validation = validateAppBuildAssetFile(file, purpose);
    if (validation) {
      setError(validation);
      clearFile();
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    try {
      setStage('正在按 4 MiB 分块计算 SHA-256');
      const checksumSha256 = await sha256Blob(file, {
        onProgress: (ratio) => setHashProgress(Math.round(ratio * 100)),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStage('正在申请一次性安全直传地址');
      const intent = await request<ContentUploadIntent>(`${base}/assets/uploads`, {
        body: JSON.stringify({
          checksumSha256,
          contentType: file.type,
          providerId,
          purpose,
          sizeBytes: file.size,
        }),
        method: 'POST',
        signal: controller.signal,
      });
      validateContentUploadIntent(intent, file, isUuidValue);
      setStage('正在上传构建图片，完成后将自动校验…');
      const uploadResponse = await fetch(intent.uploadUrl, {
        body: file,
        credentials: 'omit',
        headers: contentUploadHeaders(intent.requiredHeaders, file),
        method: 'PUT',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!uploadResponse.ok) throw new Error(`对象存储直传失败（HTTP ${uploadResponse.status}）`);
      setStage(purpose === 'app_icon'
        ? '正在校验应用图标尺寸和透明区域'
        : '正在校验启动图格式与尺寸');
      const completed = await request<AppBuildAssetCompletion>(
        `${base}/assets/uploads/${encodeURIComponent(intent.id)}/complete`,
        { method: 'POST', signal: controller.signal },
      );
      const mediaId = validateAppBuildAssetCompletion(completed, {
        checksumSha256,
        mediaId: intent.id,
        purpose,
        sizeBytes: file.size,
      });
      abortRef.current = undefined;
      clearFile();
      await onReady(mediaId);
    } catch (reason) {
      if (controller.signal.aborted) return;
      clearFile();
      setStage(undefined);
      setError(assetUploadError(reason));
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
    }
  }

  const title = purpose === 'app_icon' ? '上传应用专用图标' : '上传应用专用启动图';
  const accept = purpose === 'app_icon' ? 'image/png' : 'image/png,image/jpeg,image/webp';

  return (
    <Modal
      destroyOnHidden
      footer={null}
      maskClosable={!stage}
      onCancel={cancel}
      open={open}
      title={title}
      width={620}
    >
      <Alert
        className="page-alert"
        message={purpose === 'app_icon'
          ? '请上传 1024×1024、不含透明区域的 PNG 图标，最大 25 MiB。'
          : '启动图支持 PNG、JPEG、WebP，最大 25 MiB。'}
        showIcon
        type="info"
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>对象存储</Typography.Text>
          <Select
            disabled={Boolean(stage)}
            onChange={setProviderId}
            options={providers.map((provider) => ({
              label: `${provider.label}（${provider.ownerType === 'platform' ? '公共' : '代理商'}）`,
              value: provider.id,
            }))}
            placeholder="选择已启用的对象存储"
            style={{ display: 'block', marginTop: 6, width: '100%' }}
            value={providerId || undefined}
          />
        </div>
        <div>
          <Typography.Text strong>{purpose === 'app_icon' ? 'PNG 图标文件' : '启动图文件'}</Typography.Text>
          <Input
            accept={accept}
            disabled={Boolean(stage)}
            key={fileInputKey}
            onChange={(event) => selectFile(event.target.files?.[0])}
            style={{ display: 'block', marginTop: 6 }}
            type="file"
          />
        </div>
        {file ? (
          <Typography.Text type="secondary">已选择：{file.name} · {formatBuildBytes(String(file.size))}</Typography.Text>
        ) : null}
        {stage ? (
          <div>
            <Typography.Text>{stage}</Typography.Text>
            <Progress percent={hashProgress} size="small" status="active" />
          </div>
        ) : null}
        {error ? <Alert message={error} showIcon type="error" /> : null}
        <Button
          block
          disabled={Boolean(stage) || !file || !providerId}
          loading={Boolean(stage)}
          onClick={() => void upload()}
          type="primary"
        >
          上传图片
        </Button>
      </Space>
    </Modal>
  );
}

function BuildTargetCard({ available, busy, canManage, onCreate, title }: {
  available: boolean;
  busy: boolean;
  canManage: boolean;
  onCreate(): void;
  title: string;
}) {
  return (
    <Card size="small" style={{ width: 230 }} title={title}>
      <Typography.Paragraph type="secondary">发布通道：内部测试</Typography.Paragraph>
      <Button disabled={!available || !canManage} loading={busy} onClick={onCreate} type="primary">
        {available ? '创建构建任务' : '前置条件未满足'}
      </Button>
    </Card>
  );
}

function UnavailableTarget({ title }: { title: string }) {
  return (
    <Card size="small" style={{ width: 230 }} title={title}>
      <Typography.Paragraph type="secondary">正式发布构建当前不可用。</Typography.Paragraph>
      <Button disabled>签名链路未配置</Button>
    </Card>
  );
}

function dateTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error && reason.message) return reason.message;
  return fallback;
}

function isUuidValue(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assetUploadError(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  if (reason instanceof Error && reason.message) return reason.message.slice(0, 300);
  return '构建资产上传失败，请重新选择文件后再试';
}
