import {
  Alert,
  AutoComplete,
  Button,
  DatePicker,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type FormInstance,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { MerchantSelect } from './MerchantSelect';

interface DateValue {
  toISOString(): string;
}

interface LicensePackageRecord {
  code: string;
  createdAt: string;
  dramaIds: string[];
  id: string;
  name: string;
  status: 'active' | 'disabled';
  updatedAt: string;
  version: number;
}

interface ContentLicenseRecord {
  createdAt: string;
  dramaId?: string;
  dramaIds: string[];
  expiresAt: string;
  id: string;
  licenseType: 'drama' | 'package';
  packageId?: string;
  revokeReason?: string;
  revokedAt?: string;
  startsAt: string;
  status: 'active' | 'expired' | 'revoked' | 'scheduled';
  tenantId: string;
  tenantName: string;
  version: number;
}

interface PublicDramaRecord {
  code: string;
  id: string;
  status: 'published';
  title: string;
  totalEpisodes: number;
  version: number;
}

interface PagedResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

interface CreatePackageForm {
  code: string;
  name: string;
}

interface PackageItemsForm {
  dramaIds: string[];
}

interface GrantLicenseForm {
  dramaId?: string;
  expiresAt: DateValue;
  licenseType: 'drama' | 'package';
  packageId?: string;
  startsAt: DateValue;
  tenantId: string;
}

interface RevokeLicenseForm {
  reason: string;
}

const emptyPackages: PagedResponse<LicensePackageRecord> = {
  items: [],
  page: 1,
  pageSize: 20,
  total: 0,
};

const emptyLicenses: PagedResponse<ContentLicenseRecord> = {
  items: [],
  page: 1,
  pageSize: 20,
  total: 0,
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const licenseStatusLabels: Record<
  ContentLicenseRecord['status'],
  { color?: string; text: string }
> = {
  active: { color: 'green', text: '生效中' },
  expired: { color: 'default', text: '已过期' },
  revoked: { color: 'red', text: '已撤销' },
  scheduled: { color: 'processing', text: '待生效' },
};

export function ContentLicensingPage() {
  const { principal, request } = useAuth();
  const [createForm] = Form.useForm<CreatePackageForm>();
  const [itemsForm] = Form.useForm<PackageItemsForm>();
  const [grantForm] = Form.useForm<GrantLicenseForm>();
  const [revokeForm] = Form.useForm<RevokeLicenseForm>();
  const [messageApi, messageContext] = message.useMessage();
  const [packages, setPackages] = useState(emptyPackages);
  const [licenses, setLicenses] = useState(emptyLicenses);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [licensesLoading, setLicensesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState<string>();
  const [licensesError, setLicensesError] = useState<string>();
  const [libraryDramas, setLibraryDramas] = useState<PublicDramaRecord[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const [packageTarget, setPackageTarget] = useState<LicensePackageRecord>();
  const [revokeTarget, setRevokeTarget] = useState<ContentLicenseRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const [tenantFilterInput, setTenantFilterInput] = useState('');
  const [tenantFilter, setTenantFilter] = useState<string>();
  const packagePageSizeRef = useRef(20);
  const licensePageSizeRef = useRef(20);
  const packageLoadSequence = useRef(0);
  const licenseLoadSequence = useRef(0);
  const libraryLoadSequence = useRef(0);
  const librarySearchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const canManage = principal?.permissions.includes('content.license.manage') ?? false;

  const loadPackages = useCallback(async (
    page = 1,
    pageSize = packagePageSizeRef.current,
  ) => {
    const sequence = ++packageLoadSequence.current;
    packagePageSizeRef.current = pageSize;
    setPackagesLoading(true);
    setPackagesError(undefined);
    try {
      const result = await request<PagedResponse<LicensePackageRecord>>(
        `/api/v1/platform/content-licensing/packages?page=${page}&pageSize=${pageSize}`,
      );
      if (sequence === packageLoadSequence.current) setPackages(result);
    } catch (reason) {
      if (sequence === packageLoadSequence.current) {
        setPackagesError(errorMessage(reason, '授权包列表加载失败'));
      }
    } finally {
      if (sequence === packageLoadSequence.current) setPackagesLoading(false);
    }
  }, [request]);

  const loadLicenses = useCallback(async (
    page = 1,
    pageSize = licensePageSizeRef.current,
    filter?: string,
  ) => {
    const sequence = ++licenseLoadSequence.current;
    licensePageSizeRef.current = pageSize;
    setLicensesLoading(true);
    setLicensesError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (filter) query.set('tenantId', filter);
    try {
      const result = await request<PagedResponse<ContentLicenseRecord>>(
        `/api/v1/platform/content-licensing/licenses?${query.toString()}`,
      );
      if (sequence === licenseLoadSequence.current) setLicenses(result);
    } catch (reason) {
      if (sequence === licenseLoadSequence.current) {
        setLicensesError(errorMessage(reason, '内容授权列表加载失败'));
      }
    } finally {
      if (sequence === licenseLoadSequence.current) setLicensesLoading(false);
    }
  }, [request]);

  const loadLibraryDramas = useCallback(async (search = '') => {
    const sequence = ++libraryLoadSequence.current;
    const queryValue = search.trim();
    if (queryValue.length > 200) {
      setLibraryLoading(false);
      setLibraryError('搜索关键词不能超过 200 个字符');
      return;
    }
    setLibraryLoading(true);
    setLibraryError(undefined);
    const query = new URLSearchParams({
      page: '1',
      pageSize: '50',
      status: 'published',
    });
    if (queryValue) query.set('q', queryValue);
    try {
      const result = await request<PagedResponse<PublicDramaRecord>>(
        `/api/v1/platform/content-library/dramas?${query.toString()}`,
      );
      if (sequence === libraryLoadSequence.current) setLibraryDramas(result.items);
    } catch (reason) {
      if (sequence === libraryLoadSequence.current) {
        setLibraryError(errorMessage(reason, '公共剧目录加载失败'));
      }
    } finally {
      if (sequence === libraryLoadSequence.current) setLibraryLoading(false);
    }
  }, [request]);

  const searchLibraryDramas = useCallback((search: string) => {
    if (librarySearchTimer.current) clearTimeout(librarySearchTimer.current);
    librarySearchTimer.current = setTimeout(() => {
      void loadLibraryDramas(search);
    }, 250);
  }, [loadLibraryDramas]);

  useEffect(() => {
    void loadPackages();
    void loadLicenses();
    void loadLibraryDramas();
  }, [loadLibraryDramas, loadLicenses, loadPackages]);

  useEffect(() => () => {
    if (librarySearchTimer.current) clearTimeout(librarySearchTimer.current);
  }, []);

  async function createPackage(values: CreatePackageForm): Promise<void> {
    setSubmitting('create-package');
    try {
      await request<LicensePackageRecord>(
        '/api/v1/platform/content-licensing/packages',
        {
          body: JSON.stringify({
            code: values.code.trim().toLowerCase(),
            name: values.name.trim(),
          }),
          method: 'POST',
        },
      );
      messageApi.success('授权包已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await loadPackages(1, packages.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '授权包创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function replacePackageItems(values: PackageItemsForm): Promise<void> {
    if (!packageTarget) return;
    let dramaIds: string[];
    try {
      dramaIds = validateDramaIds(values.dramaIds);
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : '公共剧 ID 格式错误');
      return;
    }
    setSubmitting(`package-items:${packageTarget.id}`);
    try {
      await request<LicensePackageRecord>(
        `/api/v1/platform/content-licensing/packages/${encodeURIComponent(packageTarget.id)}/items`,
        {
          body: JSON.stringify({ dramaIds, version: packageTarget.version }),
          method: 'PUT',
        },
      );
      messageApi.success('授权包内容已更新');
      setPackageTarget(undefined);
      itemsForm.resetFields();
      await loadPackages(packages.page, packages.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '授权包内容更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function grantLicense(values: GrantLicenseForm): Promise<void> {
    const startsAt = values.startsAt.toISOString();
    const expiresAt = values.expiresAt.toISOString();
    if (expiresAt <= startsAt) {
      messageApi.error('授权到期时间必须晚于开始时间');
      return;
    }
    setSubmitting('grant-license');
    try {
      await request<ContentLicenseRecord>(
        '/api/v1/platform/content-licensing/licenses',
        {
          body: JSON.stringify({
            dramaId: values.licenseType === 'drama' ? values.dramaId?.trim() : undefined,
            expiresAt,
            licenseType: values.licenseType,
            packageId: values.licenseType === 'package' ? values.packageId : undefined,
            startsAt,
            tenantId: values.tenantId.trim(),
          }),
          method: 'POST',
        },
      );
      messageApi.success('内容授权已发放');
      setGrantOpen(false);
      grantForm.resetFields();
      setTenantFilter(undefined);
      setTenantFilterInput('');
      await loadLicenses(1, licenses.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '内容授权发放失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function revokeLicense(values: RevokeLicenseForm): Promise<void> {
    if (!revokeTarget) return;
    setSubmitting(`revoke:${revokeTarget.id}`);
    try {
      await request<ContentLicenseRecord>(
        `/api/v1/platform/content-licensing/licenses/${encodeURIComponent(revokeTarget.id)}/revoke`,
        {
          body: JSON.stringify({
            reason: values.reason.trim(),
            version: revokeTarget.version,
          }),
          method: 'POST',
        },
      );
      messageApi.success('内容授权已撤销');
      setRevokeTarget(undefined);
      revokeForm.resetFields();
      await loadLicenses(licenses.page, licenses.pageSize, tenantFilter);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '内容授权撤销失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function applyTenantFilter(): void {
    const value = tenantFilterInput.trim();
    if (value && !UUID_PATTERN.test(value)) {
      messageApi.error('请输入有效的代理商 UUID');
      return;
    }
    const nextFilter = value || undefined;
    setTenantFilter(nextFilter);
    void loadLicenses(1, licenses.pageSize, nextFilter);
  }

  function clearTenantFilter(): void {
    setTenantFilterInput('');
    setTenantFilter(undefined);
    void loadLicenses(1, licenses.pageSize);
  }

  const packageOptions = useMemo(
    () => packages.items
      .filter((item) => item.status === 'active')
      .map((item) => ({
        label: `${item.name}（${item.dramaIds.length} 部）`,
        value: item.id,
      })),
    [packages.items],
  );

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>公共内容授权</Typography.Title>
          <Typography.Text type="secondary">
            将平台自有公共剧以单剧或授权包的方式发放给代理商。
          </Typography.Text>
        </div>
        {canManage ? (
          <Button type="primary" onClick={() => {
            setGrantOpen(true);
            void loadLibraryDramas();
          }}>
            发放授权
          </Button>
        ) : null}
      </div>

      <Alert
        className="page-alert"
        description="选择公共剧和代理商，设置授权有效期。"
        message="公共内容授权"
        showIcon
        type="info"
      />

      <Tabs
        items={[
          {
            children: (
              <PackagePanel
                canManage={canManage}
                data={packages}
                error={packagesError}
                loading={packagesLoading}
                onCreate={() => setCreateOpen(true)}
                onEdit={(item) => {
                  setPackageTarget(item);
                  void loadLibraryDramas();
                }}
                onPageChange={(page, pageSize) => void loadPackages(page, pageSize)}
                onRetry={() => void loadPackages(packages.page, packages.pageSize)}
              />
            ),
            key: 'packages',
            label: '授权包',
          },
          {
            children: (
              <LicensePanel
                canManage={canManage}
                data={licenses}
                error={licensesError}
                filter={tenantFilter}
                filterInput={tenantFilterInput}
                loading={licensesLoading}
                onApplyFilter={applyTenantFilter}
                onClearFilter={clearTenantFilter}
                onFilterInput={setTenantFilterInput}
                onPageChange={(page, pageSize) => void loadLicenses(
                  page,
                  pageSize,
                  tenantFilter,
                )}
                onRetry={() => void loadLicenses(
                  licenses.page,
                  licenses.pageSize,
                  tenantFilter,
                )}
                onRevoke={setRevokeTarget}
                submitting={submitting}
              />
            ),
            key: 'licenses',
            label: '授权记录',
          },
        ]}
      />

      <CreatePackageModal
        form={createForm}
        loading={submitting === 'create-package'}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onFinish={(values) => void createPackage(values)}
        open={createOpen}
      />
      <PackageItemsModal
        form={itemsForm}
        libraryDramas={libraryDramas}
        libraryError={libraryError}
        libraryLoading={libraryLoading}
        loading={submitting === `package-items:${packageTarget?.id}`}
        onCancel={() => {
          if (!submitting) {
            setPackageTarget(undefined);
            itemsForm.resetFields();
          }
        }}
        onFinish={(values) => void replacePackageItems(values)}
        onLibraryRetry={() => void loadLibraryDramas()}
        onLibrarySearch={searchLibraryDramas}
        target={packageTarget}
      />
      <GrantLicenseModal
        form={grantForm}
        libraryDramas={libraryDramas}
        libraryError={libraryError}
        libraryLoading={libraryLoading}
        loading={submitting === 'grant-license'}
        onCancel={() => {
          setGrantOpen(false);
          grantForm.resetFields();
        }}
        onFinish={(values) => void grantLicense(values)}
        onLibraryRetry={() => void loadLibraryDramas()}
        onLibrarySearch={searchLibraryDramas}
        open={grantOpen}
        packageOptions={packageOptions}
      />
      <RevokeLicenseModal
        form={revokeForm}
        loading={submitting === `revoke:${revokeTarget?.id}`}
        onCancel={() => {
          if (!submitting) {
            setRevokeTarget(undefined);
            revokeForm.resetFields();
          }
        }}
        onFinish={(values) => void revokeLicense(values)}
        target={revokeTarget}
      />
    </>
  );
}

function PackagePanel({
  canManage,
  data,
  error,
  loading,
  onCreate,
  onEdit,
  onPageChange,
  onRetry,
}: {
  canManage: boolean;
  data: PagedResponse<LicensePackageRecord>;
  error?: string;
  loading: boolean;
  onCreate(): void;
  onEdit(item: LicensePackageRecord): void;
  onPageChange(page: number, pageSize: number): void;
  onRetry(): void;
}) {
  return (
    <>
      <div className="licensing-panel-toolbar">
        <Typography.Text type="secondary">维护授权包内的剧目。</Typography.Text>
        {canManage ? <Button onClick={onCreate}>创建授权包</Button> : null}
      </div>
      {error ? (
        <Alert
          action={<Button size="small" onClick={onRetry}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}
      <Table<LicensePackageRecord>
        columns={[
          {
            dataIndex: 'name',
            title: '授权包',
            render: (name: string, item) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{name}</Typography.Text>
                <Typography.Text type="secondary">{item.code}</Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'status',
            title: '状态',
            width: 100,
            render: (status: LicensePackageRecord['status']) => status === 'active'
              ? <Tag color="green">启用</Tag>
              : <Tag>停用</Tag>,
          },
          {
            dataIndex: 'dramaIds',
            title: '公共剧',
            render: (dramaIds: string[]) => <DramaIdSummary dramaIds={dramaIds} />,
          },
          {
            dataIndex: 'updatedAt',
            title: '更新时间',
            width: 180,
            render: formatDateTime,
          },
          { dataIndex: 'version', title: '版本', width: 75 },
          {
            fixed: 'right',
            key: 'actions',
            title: '操作',
            width: 110,
            render: (_, item) => canManage ? (
              <Button size="small" onClick={() => onEdit(item)}>管理内容</Button>
            ) : <Typography.Text type="secondary">只读</Typography.Text>,
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无授权包" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: onPageChange,
          pageSize: data.pageSize,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1000 }}
      />
    </>
  );
}

function LicensePanel({
  canManage,
  data,
  error,
  filter,
  filterInput,
  loading,
  onApplyFilter,
  onClearFilter,
  onFilterInput,
  onPageChange,
  onRetry,
  onRevoke,
  submitting,
}: {
  canManage: boolean;
  data: PagedResponse<ContentLicenseRecord>;
  error?: string;
  filter?: string;
  filterInput: string;
  loading: boolean;
  onApplyFilter(): void;
  onClearFilter(): void;
  onFilterInput(value: string): void;
  onPageChange(page: number, pageSize: number): void;
  onRetry(): void;
  onRevoke(item: ContentLicenseRecord): void;
  submitting?: string;
}) {
  return (
    <>
      <div className="licensing-panel-toolbar">
        <Space.Compact>
          <MerchantSelect onChange={onFilterInput} value={filterInput} />
          <Button loading={loading} onClick={onApplyFilter} type="primary">筛选</Button>
          {filter ? <Button onClick={onClearFilter}>清除</Button> : null}
        </Space.Compact>
        {filter ? <Tag color="blue">已筛选代理商</Tag> : null}
      </div>
      {error ? (
        <Alert
          action={<Button size="small" onClick={onRetry}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}
      <Table<ContentLicenseRecord>
        columns={[
          {
            dataIndex: 'tenantName',
            title: '代理商',
            render: (tenantName: string, item) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{tenantName}</Typography.Text>
                <Typography.Text className="secondary-id" copyable={{ text: item.tenantId }} type="secondary">
                  {item.tenantId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'licenseType',
            title: '授权方式',
            width: 170,
            render: (licenseType: ContentLicenseRecord['licenseType'], item) => (
              <Space direction="vertical" size={0}>
                <Tag color={licenseType === 'package' ? 'purple' : 'blue'}>
                  {licenseType === 'package' ? '授权包' : '单剧'}
                </Tag>
                <Typography.Text className="secondary-id" copyable type="secondary">
                  {item.packageId ?? item.dramaId ?? '—'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'dramaIds',
            title: '授权范围',
            render: (dramaIds: string[]) => <DramaIdSummary dramaIds={dramaIds} />,
          },
          {
            key: 'period',
            title: '授权周期',
            width: 200,
            render: (_, item) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{formatDateTime(item.startsAt)}</Typography.Text>
                <Typography.Text type="secondary">至 {formatDateTime(item.expiresAt)}</Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'status',
            title: '状态',
            width: 130,
            render: (status: ContentLicenseRecord['status'], item) => {
              const option = licenseStatusLabels[status];
              return (
                <Space direction="vertical" size={0}>
                  <Tag color={option.color}>{option.text}</Tag>
                  {item.revokeReason ? (
                    <Typography.Text type="secondary">{item.revokeReason}</Typography.Text>
                  ) : null}
                </Space>
              );
            },
          },
          {
            fixed: 'right',
            key: 'actions',
            title: '操作',
            width: 100,
            render: (_, item) => canManage && item.status !== 'revoked' ? (
              <Button
                danger
                disabled={submitting === `revoke:${item.id}`}
                loading={submitting === `revoke:${item.id}`}
                size="small"
                onClick={() => onRevoke(item)}
              >
                撤销
              </Button>
            ) : <Typography.Text type="secondary">—</Typography.Text>,
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无授权记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: onPageChange,
          pageSize: data.pageSize,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1300 }}
      />
    </>
  );
}

function DramaIdSummary({ dramaIds }: { dramaIds: string[] }) {
  if (!dramaIds.length) return <Typography.Text type="secondary">空授权包</Typography.Text>;
  return (
    <Space direction="vertical" size={0}>
      <Typography.Text>{dramaIds.length} 部公共剧</Typography.Text>
      <Typography.Text
        className="secondary-id"
        copyable={{ text: dramaIds.join('\n') }}
        type="secondary"
      >
        {dramaIds[0]}
      </Typography.Text>
    </Space>
  );
}

function PublicDramaMultiSelect({
  dramas,
  loading,
  onChange,
  onSearch,
  value = [],
}: {
  dramas: PublicDramaRecord[];
  loading: boolean;
  onChange?(value: string[]): void;
  onSearch(search: string): void;
  value?: string[];
}) {
  const options = useMemo(
    () => mergePublicDramaOptions(dramas, value),
    [dramas, value],
  );
  return (
    <Select
      allowClear
      filterOption={false}
      loading={loading}
      mode="tags"
      notFoundContent={loading ? '搜索中…' : '没有匹配的已发布公共剧'}
      onChange={(nextValue) => onChange?.(nextValue)}
      onSearch={onSearch}
      options={options}
      placeholder="搜索剧名或代码，可多选"
      showSearch
      tokenSeparators={[',', ';', '\n']}
      value={value}
    />
  );
}

function PublicDramaAutoComplete({
  dramas,
  loading,
  onChange,
  onSearch,
  value,
}: {
  dramas: PublicDramaRecord[];
  loading: boolean;
  onChange?(value: string): void;
  onSearch(search: string): void;
  value?: string;
}) {
  return (
    <AutoComplete
      notFoundContent={loading ? '搜索中…' : '没有匹配的已发布公共剧'}
      onChange={onChange}
      onSearch={onSearch}
      options={mergePublicDramaOptions(dramas, value ? [value] : [])}
      placeholder="搜索并选择公共剧"
      value={value}
    />
  );
}

function mergePublicDramaOptions(
  dramas: PublicDramaRecord[],
  selectedIds: string[],
): Array<{ label: string; value: string }> {
  const options = dramas.map((drama) => ({
    label: `${drama.title} · ${drama.code} · ${drama.totalEpisodes} 集`,
    value: drama.id,
  }));
  const loadedIds = new Set(dramas.map((drama) => drama.id));
  for (const selectedId of selectedIds) {
    if (selectedId && !loadedIds.has(selectedId)) {
      options.push({
        label: `已选（未在当前搜索结果）· ${selectedId}`,
        value: selectedId,
      });
    }
  }
  return options;
}

function LibraryError({ error, onRetry }: { error?: string; onRetry(): void }) {
  return error ? (
    <Alert
      action={<Button size="small" onClick={onRetry}>重试</Button>}
      className="page-alert"
      message={error}
      showIcon
      type="error"
    />
  ) : null;
}

function CreatePackageModal({
  form,
  loading,
  onCancel,
  onFinish,
  open,
}: {
  form: FormInstance<CreatePackageForm>;
  loading: boolean;
  onCancel(): void;
  onFinish(values: CreatePackageForm): void;
  open: boolean;
}) {
  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okText="创建"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={open}
      title="创建授权包"
    >
      <Form<CreatePackageForm>
        name="contentlicensingpage-1" form={form}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
      >
        <Form.Item
          extra="创建后作为稳定业务标识"
          label="授权包代码"
          name="code"
          rules={[
            { required: true, message: '请输入授权包代码' },
            {
              message: '2–128 位小写字母、数字、下划线或连字符',
              pattern: /^[a-z0-9][a-z0-9_-]{1,127}$/,
            },
          ]}
        >
          <Input maxLength={128} placeholder="japan_popular_2026" />
        </Form.Item>
        <Form.Item
          label="授权包名称"
          name="name"
          rules={[{ required: true, message: '请输入名称', whitespace: true }]}
        >
          <Input maxLength={200} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PackageItemsModal({
  form,
  libraryDramas,
  libraryError,
  libraryLoading,
  loading,
  onCancel,
  onFinish,
  onLibraryRetry,
  onLibrarySearch,
  target,
}: {
  form: FormInstance<PackageItemsForm>;
  libraryDramas: PublicDramaRecord[];
  libraryError?: string;
  libraryLoading: boolean;
  loading: boolean;
  onCancel(): void;
  onFinish(values: PackageItemsForm): void;
  onLibraryRetry(): void;
  onLibrarySearch(search: string): void;
  target?: LicensePackageRecord;
}) {
  useEffect(() => {
    if (target) form.setFieldsValue({ dramaIds: target.dramaIds });
  }, [form, target]);

  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okText="保存授权内容"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={Boolean(target)}
      title={`管理授权包·${target?.name ?? ''}`}
      width={680}
    >
      <Alert
        className="page-alert"
        description="按剧目编号或标题搜索，选中后保存。"
        message="仅可选择已发布的平台公共剧"
        showIcon
        type="warning"
      />
      <LibraryError error={libraryError} onRetry={onLibraryRetry} />
      <Form<PackageItemsForm>
        name="contentlicensingpage-2" form={form}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
      >
        <Form.Item
          label="公共剧"
          name="dramaIds"
          rules={[{
            validator: async (_, value?: string[]) => {
              validateDramaIds(value);
            },
          }]}
        >
          <PublicDramaMultiSelect
            dramas={libraryDramas}
            loading={libraryLoading}
            onSearch={onLibrarySearch}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function GrantLicenseModal({
  form,
  libraryDramas,
  libraryError,
  libraryLoading,
  loading,
  onCancel,
  onFinish,
  onLibraryRetry,
  onLibrarySearch,
  open,
  packageOptions,
}: {
  form: FormInstance<GrantLicenseForm>;
  libraryDramas: PublicDramaRecord[];
  libraryError?: string;
  libraryLoading: boolean;
  loading: boolean;
  onCancel(): void;
  onFinish(values: GrantLicenseForm): void;
  onLibraryRetry(): void;
  onLibrarySearch(search: string): void;
  open: boolean;
  packageOptions: Array<{ label: string; value: string }>;
}) {
  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okText="确认发放"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={open}
      title="发放公共内容授权"
      width={680}
    >
      <Alert
        className="page-alert"
        description="授权到期时间不能超过代理商到期时间；单剧必须是已发布的平台公共剧。"
        message="发放后代理商只获得授权使用权"
        showIcon
        type="info"
      />
      <LibraryError error={libraryError} onRetry={onLibraryRetry} />
      <Form<GrantLicenseForm>
        name="contentlicensingpage-3" form={form}
        initialValues={{ licenseType: 'drama' }}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
      >
        <Form.Item
          label="代理商"
          name="tenantId"
          rules={[
            { required: true, message: '请选择代理商' },
            { message: '请选择有效的代理商', pattern: UUID_PATTERN },
          ]}
        >
          <MerchantSelect />
        </Form.Item>
        <Form.Item label="授权方式" name="licenseType" rules={[{ required: true }]}>
          <Select options={[
            { label: '单剧授权', value: 'drama' },
            { label: '授权包', value: 'package' },
          ]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.licenseType !== current.licenseType}>
          {({ getFieldValue }) => getFieldValue('licenseType') === 'package' ? (
            <Form.Item
              label="授权包"
              name="packageId"
              rules={[{ required: true, message: '请选择授权包' }]}
            >
              <Select
                notFoundContent="当前页没有可用授权包"
                options={packageOptions}
                placeholder="选择已启用的授权包"
              />
            </Form.Item>
          ) : (
            <Form.Item
              extra="按剧目编号或标题搜索。"
              label="已发布公共剧"
              name="dramaId"
              rules={[
                { required: true, message: '请选择公共剧' },
                { message: '请从搜索结果中选择有效的公共剧', pattern: UUID_PATTERN },
              ]}
            >
              <PublicDramaAutoComplete
                dramas={libraryDramas}
                loading={libraryLoading}
                onSearch={onLibrarySearch}
              />
            </Form.Item>
          )}
        </Form.Item>
        <div className="two-column-form">
          <Form.Item label="开始时间" name="startsAt" rules={[{ required: true, message: '请选择开始时间' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="到期时间" name="expiresAt" rules={[{ required: true, message: '请选择到期时间' }]}>
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
}

function RevokeLicenseModal({
  form,
  loading,
  onCancel,
  onFinish,
  target,
}: {
  form: FormInstance<RevokeLicenseForm>;
  loading: boolean;
  onCancel(): void;
  onFinish(values: RevokeLicenseForm): void;
  target?: ContentLicenseRecord;
}) {
  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okButtonProps={{ danger: true }}
      okText="确认撤销"
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={Boolean(target)}
      title="撤销内容授权"
    >
      <Typography.Paragraph type="secondary">
        撤销「{target?.tenantName}」的当前授权后，对应公共剧将不再对该代理商可用。
      </Typography.Paragraph>
      <Form<RevokeLicenseForm>
        name="contentlicensingpage-4" form={form}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
      >
        <Form.Item
          label="撤销原因"
          name="reason"
          rules={[
            { required: true, message: '请填写撤销原因', whitespace: true },
            { max: 2000, message: '撤销原因不能超过 2000 字' },
          ]}
        >
          <Input.TextArea maxLength={2000} rows={4} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function validateDramaIds(value: string[] | undefined): string[] {
  const dramaIds = [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
  if (dramaIds.length > 1000) throw new Error('单个授权包最多 1000 部公共剧');
  const invalid = dramaIds.find((dramaId) => !UUID_PATTERN.test(dramaId));
  if (invalid) throw new Error(`公共剧 UUID 格式错误：${invalid}`);
  return dramaIds;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
