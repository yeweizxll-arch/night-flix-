import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { customerResourcePath, isValidTenantId } from './customer-management-ui';

type CustomerStatus = 'active' | 'disabled';

interface CustomerDevice {
  activeSessions: number;
  id: string;
  label?: string;
  lastSeenAt: string;
  platform: 'android' | 'h5' | 'ios' | 'web';
  status: 'active' | 'revoked';
}

interface CustomerRecord {
  activeEntitlements: { drama: number; episode: number; membership: number; total: number };
  createdAt: string;
  devices: CustomerDevice[];
  email?: string;
  emailVerified: boolean;
  id: string;
  orders: { paid: number; refunded: number; total: number };
  phone?: string;
  phoneVerified: boolean;
  pointsBalance: string;
  status: CustomerStatus;
  tenantId: string;
  updatedAt: string;
  username: string;
  version: number;
}

interface CustomerListResponse {
  items: CustomerRecord[];
  nextCursor: string | null;
  pageSize: number;
}

interface Filters {
  q: string;
  registeredFrom: string;
  registeredTo: string;
  status?: CustomerStatus;
}

interface ConfirmForm {
  confirmed: boolean;
  reason: string;
}

interface Props {
  apiBase: string;
  managePermission: string;
  readPermission: string;
  scope: 'platform' | 'tenant';
  sessionRevokePermission: string;
  title: string;
}

const initialFilters: Filters = { q: '', registeredFrom: '', registeredTo: '' };
const emptyList: CustomerListResponse = { items: [], nextCursor: null, pageSize: 20 };

export function CustomerManagementPage({
  apiBase,
  managePermission,
  readPermission,
  scope,
  sessionRevokePermission,
  title,
}: Props) {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [statusForm] = Form.useForm<ConfirmForm>();
  const [revokeForm] = Form.useForm<ConfirmForm>();
  const [tenantInput, setTenantInput] = useState('');
  const [tenantId, setTenantId] = useState<string>();
  const [draftFilters, setDraftFilters] = useState<Filters>(initialFilters);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [list, setList] = useState<CustomerListResponse>(emptyList);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(scope === 'tenant');
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<CustomerRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [statusTarget, setStatusTarget] = useState<CustomerRecord>();
  const [revokeTarget, setRevokeTarget] = useState<{ deviceId?: string; record: CustomerRecord }>();
  const [submitting, setSubmitting] = useState<string>();
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes(readPermission);
  const canManage = permissions.includes(managePermission);
  const canRevoke = permissions.includes(sessionRevokePermission);
  const effectiveTenantId = scope === 'platform' ? tenantId : undefined;
  const ready = canRead && (scope === 'tenant' || Boolean(effectiveTenantId));
  const currentCursor = cursorStack[pageIndex];

  const load = useCallback(async () => {
    if (!ready) {
      listSequence.current += 1;
      setLoading(false);
      setList(emptyList);
      return;
    }
    const sequence = ++listSequence.current;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({ pageSize: String(list.pageSize) });
    if (effectiveTenantId) query.set('tenantId', effectiveTenantId);
    if (currentCursor) query.set('cursor', currentCursor);
    if (filters.q) query.set('q', filters.q);
    if (filters.status) query.set('status', filters.status);
    if (filters.registeredFrom) query.set('registeredFrom', filters.registeredFrom);
    if (filters.registeredTo) query.set('registeredTo', filters.registeredTo);
    try {
      const result = await request<CustomerListResponse>(`${apiBase}?${query}`);
      if (sequence === listSequence.current) setList(result);
    } catch (reason) {
      if (sequence === listSequence.current) setError(errorMessage(reason, '用户列表加载失败'));
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, [apiBase, currentCursor, effectiveTenantId, filters, list.pageSize, ready, request]);

  useEffect(() => { void load(); }, [load]);

  function resetPagination(): void {
    listSequence.current += 1;
    setCursorStack([undefined]);
    setPageIndex(0);
  }

  function chooseTenant(): void {
    const normalized = tenantInput.trim().toLowerCase();
    if (!isValidTenantId(normalized)) {
      messageApi.error('请输入有效的商家 UUID');
      return;
    }
    closeDetail();
    resetPagination();
    setTenantId(normalized);
  }

  function applyFilters(): void {
    if (draftFilters.registeredFrom && draftFilters.registeredTo
      && draftFilters.registeredFrom > draftFilters.registeredTo) {
      messageApi.error('注册开始日期不能晚于结束日期');
      return;
    }
    resetPagination();
    setFilters({
      ...draftFilters,
      q: draftFilters.q.trim(),
      registeredFrom: draftFilters.registeredFrom.trim(),
      registeredTo: draftFilters.registeredTo.trim(),
    });
  }

  async function openDetail(record: CustomerRecord): Promise<void> {
    const sequence = ++detailSequence.current;
    setSelected(record);
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const detail = await request<CustomerRecord>(customerResourcePath(apiBase, record.id, effectiveTenantId));
      if (sequence === detailSequence.current) setSelected(detail);
    } catch (reason) {
      if (sequence === detailSequence.current) setDetailError(errorMessage(reason, '用户详情加载失败'));
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    setSelected(undefined);
    setDetailError(undefined);
  }

  function openStatus(record: CustomerRecord): void {
    statusForm.resetFields();
    statusForm.setFieldsValue({ confirmed: false });
    setStatusTarget(record);
  }

  async function changeStatus(values: ConfirmForm): Promise<void> {
    if (!statusTarget) return;
    const nextStatus: CustomerStatus = statusTarget.status === 'active' ? 'disabled' : 'active';
    setSubmitting(`status:${statusTarget.id}`);
    try {
      await request(customerResourcePath(apiBase, statusTarget.id, effectiveTenantId, 'status'), {
        body: JSON.stringify({
          expectedVersion: statusTarget.version,
          reason: values.reason.trim(),
          status: nextStatus,
        }),
        method: 'PATCH',
      });
      messageApi.success(nextStatus === 'disabled'
        ? '用户已停用，现有会话和推送令牌已撤销'
        : '用户已启用；旧会话不会恢复');
      setStatusTarget(undefined);
      statusForm.resetFields();
      closeDetail();
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '用户状态更新失败'));
      if (isConflict(reason)) {
        setStatusTarget(undefined);
        closeDetail();
        await load();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function openRevoke(record: CustomerRecord, deviceId?: string): void {
    revokeForm.resetFields();
    revokeForm.setFieldsValue({ confirmed: false });
    setRevokeTarget({ deviceId, record });
  }

  async function revokeSessions(values: ConfirmForm): Promise<void> {
    if (!revokeTarget) return;
    const { deviceId, record } = revokeTarget;
    setSubmitting(`sessions:${record.id}:${deviceId ?? 'all'}`);
    try {
      const response = await request<{
        deviceRevoked?: boolean;
        pushTokensRevoked?: number;
        sessionsRevoked: number;
      }>(
        customerResourcePath(apiBase, record.id, effectiveTenantId, 'revoke-sessions'),
        {
          body: JSON.stringify({
            ...(deviceId ? { deviceId } : {}),
            reason: values.reason.trim(),
          }),
          method: 'POST',
        },
      );
      messageApi.success(deviceId
        ? `设备已撤销，同时撤销 ${response.sessionsRevoked} 个会话和 ${response.pushTokensRevoked ?? 0} 个推送令牌`
        : `已撤销 ${response.sessionsRevoked} 个活动会话`);
      setRevokeTarget(undefined);
      revokeForm.resetFields();
      await openDetail(record);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '会话撤销失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">
            联系方式仅显示掩码；积分、会员权益和订单数据均为只读，不能在此修改。
          </Typography.Text>
        </div>
      </div>

      {scope === 'platform' ? (
        <Alert
          className="page-alert"
          description="为避免全库模糊扫描，总后台必须先输入准确的商家 UUID，再查询该商家的用户。"
          message="先选择商家"
          showIcon
          type="info"
        />
      ) : null}
      {error ? <RetryAlert message={error} onRetry={() => void load()} /> : null}
      <div className="audit-filter-card">
        <Space wrap>
          {scope === 'platform' ? (
            <>
              <Input
                maxLength={36}
                onChange={(event) => setTenantInput(event.target.value)}
                onPressEnter={chooseTenant}
                placeholder="商家 UUID"
                style={{ width: 330 }}
                value={tenantInput}
              />
              <Button onClick={chooseTenant} type="primary">查询商家用户</Button>
            </>
          ) : null}
          <Input
            allowClear
            maxLength={100}
            onChange={(event) => setDraftFilters((current) => ({ ...current, q: event.target.value }))}
            placeholder="用户名模糊；邮箱/+手机号精确"
            style={{ width: 300 }}
            value={draftFilters.q}
          />
          <Select
            allowClear
            onChange={(status) => setDraftFilters((current) => ({ ...current, status }))}
            options={[
              { label: '正常', value: 'active' },
              { label: '停用', value: 'disabled' },
            ]}
            placeholder="全部状态"
            style={{ width: 120 }}
            value={draftFilters.status}
          />
          <Input
            onChange={(event) => setDraftFilters((current) => ({ ...current, registeredFrom: event.target.value }))}
            placeholder="注册开始 YYYY-MM-DD"
            style={{ width: 190 }}
            value={draftFilters.registeredFrom}
          />
          <Input
            onChange={(event) => setDraftFilters((current) => ({ ...current, registeredTo: event.target.value }))}
            placeholder="注册结束 YYYY-MM-DD"
            style={{ width: 190 }}
            value={draftFilters.registeredTo}
          />
          <Button disabled={!ready} onClick={applyFilters}>筛选</Button>
          <Button disabled={!ready} loading={loading} onClick={() => void load()}>刷新</Button>
        </Space>
      </div>

      {!ready && scope === 'platform' ? (
        <Empty description="输入商家 UUID 后查询；系统不会自动加载全平台用户" />
      ) : (
        <Table<CustomerRecord>
          columns={[
            {
              key: 'account',
              title: '用户',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Button className="table-link-button" onClick={() => void openDetail(record)} type="link">
                    {record.username}
                  </Button>
                  <Typography.Text className="secondary-id" type="secondary">{record.id}</Typography.Text>
                </Space>
              ),
            },
            {
              key: 'contact',
              title: '联系方式（脱敏）',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>{record.email ?? '—'} {record.emailVerified ? '✓' : ''}</Typography.Text>
                  <Typography.Text>{record.phone ?? '—'} {record.phoneVerified ? '✓' : ''}</Typography.Text>
                </Space>
              ),
            },
            { dataIndex: 'status', title: '状态', width: 90, render: (value: CustomerStatus) => <StatusTag status={value} /> },
            { dataIndex: 'pointsBalance', title: '积分（只读）', width: 130 },
            { key: 'orders', title: '订单（只读）', width: 130, render: (_, record) => `${record.orders.total} 笔` },
            { dataIndex: 'createdAt', title: '注册时间', width: 180, render: formatDateTime },
            {
              key: 'actions',
              title: '操作',
              width: 230,
              render: (_, record) => (
                <Space wrap>
                  <Button size="small" onClick={() => void openDetail(record)}>详情</Button>
                  {canManage ? (
                    <Button danger={record.status === 'active'} size="small" onClick={() => openStatus(record)}>
                      {record.status === 'active' ? '停用' : '启用'}
                    </Button>
                  ) : null}
                  {canRevoke ? <Button size="small" onClick={() => openRevoke(record)}>全部下线</Button> : null}
                  {!canManage && !canRevoke ? <Typography.Text type="secondary">只读</Typography.Text> : null}
                </Space>
              ),
            },
          ]}
          dataSource={list.items}
          loading={loading}
          locale={{ emptyText: <Empty description="暂无符合条件的用户" /> }}
          pagination={false}
          rowKey="id"
          scroll={{ x: 1200 }}
        />
      )}
      {ready ? (
        <Space className="table-pagination" wrap>
          <Select
            onChange={(pageSize) => {
              resetPagination();
              setList((current) => ({ ...current, pageSize }));
            }}
            options={[20, 50, 100].map((value) => ({ label: `${value} 条/页`, value }))}
            value={list.pageSize}
          />
          <Button
            disabled={pageIndex === 0 || loading}
            onClick={() => {
              setCursorStack((current) => current.slice(0, -1));
              setPageIndex((current) => Math.max(0, current - 1));
            }}
          >上一页</Button>
          <Typography.Text type="secondary">第 {pageIndex + 1} 页</Typography.Text>
          <Button
            disabled={!list.nextCursor || loading}
            onClick={() => {
              if (!list.nextCursor) return;
              setCursorStack((current) => [...current.slice(0, pageIndex + 1), list.nextCursor!]);
              setPageIndex((current) => current + 1);
            }}
          >下一页</Button>
        </Space>
      ) : null}

      <Drawer
        destroyOnHidden
        loading={detailLoading}
        onClose={closeDetail}
        open={Boolean(selected)}
        title="用户详情"
        width={760}
      >
        {detailError ? (
          <RetryAlert message={detailError} onRetry={() => selected && void openDetail(selected)} />
        ) : selected ? (
          <CustomerDetail canRevoke={canRevoke} onRevoke={openRevoke} record={selected} />
        ) : null}
      </Drawer>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setStatusTarget(undefined)}
        open={Boolean(statusTarget)}
        title={statusTarget?.status === 'active' ? '停用用户' : '启用用户'}
      >
        <Alert
          className="page-alert"
          message={statusTarget?.status === 'active'
            ? '停用后，全部登录会话与推送令牌会立即失效。'
            : '启用只恢复账号状态，不会恢复任何旧会话。'}
          showIcon
          type="warning"
        />
        <Form form={statusForm} layout="vertical" onFinish={(values) => void changeStatus(values)}>
          <Form.Item label="操作原因" name="reason" rules={[{ max: 1000, min: 2, required: true, whitespace: true }]}>
            <Input.TextArea maxLength={1000} rows={3} showCount />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmValidator }]} valuePropName="checked">
            <Checkbox>我已确认用户 ID 和本次操作影响</Checkbox>
          </Form.Item>
          <Button
            block
            danger={statusTarget?.status === 'active'}
            htmlType="submit"
            loading={Boolean(statusTarget && submitting === `status:${statusTarget.id}`)}
            type="primary"
          >确认{statusTarget?.status === 'active' ? '停用' : '启用'}</Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setRevokeTarget(undefined)}
        open={Boolean(revokeTarget)}
        title={revokeTarget?.deviceId ? '撤销该设备' : '踢下全部会话'}
      >
        <Alert
          className="page-alert"
          message={revokeTarget?.deviceId
            ? '单设备操作会撤销设备身份、该设备推送令牌及活动会话；用户需重新登录建立新设备身份。'
            : '全部下线只撤销现有会话，不停用账号或设备；用户之后仍可重新登录。'}
          showIcon
          type="info"
        />
        <Form form={revokeForm} layout="vertical" onFinish={(values) => void revokeSessions(values)}>
          <Form.Item label="下线原因" name="reason" rules={[{ max: 1000, min: 2, required: true, whitespace: true }]}>
            <Input.TextArea maxLength={1000} rows={3} showCount />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmValidator }]} valuePropName="checked">
            <Checkbox>我确认撤销所选范围内的全部活动会话</Checkbox>
          </Form.Item>
          <Button
            block
            danger
            htmlType="submit"
            loading={Boolean(revokeTarget && submitting === `sessions:${revokeTarget.record.id}:${revokeTarget.deviceId ?? 'all'}`)}
            type="primary"
          >确认{revokeTarget?.deviceId ? '撤销设备' : '踢下会话'}</Button>
        </Form>
      </Modal>
    </>
  );
}

function CustomerDetail({
  canRevoke,
  onRevoke,
  record,
}: {
  canRevoke: boolean;
  onRevoke(record: CustomerRecord, deviceId?: string): void;
  record: CustomerRecord;
}) {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="用户 ID"><Typography.Text copyable>{record.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="商家 ID"><Typography.Text copyable>{record.tenantId}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="用户名">{record.username}</Descriptions.Item>
        <Descriptions.Item label="邮箱（脱敏）">{record.email ?? '—'} / {record.emailVerified ? '已验证' : '未验证'}</Descriptions.Item>
        <Descriptions.Item label="手机号（脱敏）">{record.phone ?? '—'} / {record.phoneVerified ? '已验证' : '未验证'}</Descriptions.Item>
        <Descriptions.Item label="状态"><StatusTag status={record.status} /></Descriptions.Item>
        <Descriptions.Item label="积分余额（只读）">{record.pointsBalance}</Descriptions.Item>
        <Descriptions.Item label="有效权益（只读）">
          合计 {record.activeEntitlements.total}；会员 {record.activeEntitlements.membership}；短剧 {record.activeEntitlements.drama}；单集 {record.activeEntitlements.episode}
        </Descriptions.Item>
        <Descriptions.Item label="订单摘要（只读）">
          合计 {record.orders.total}；已支付 {record.orders.paid}；已退款 {record.orders.refunded}
        </Descriptions.Item>
        <Descriptions.Item label="版本">{record.version}</Descriptions.Item>
        <Descriptions.Item label="注册时间">{formatDateTime(record.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{formatDateTime(record.updatedAt)}</Descriptions.Item>
      </Descriptions>
      <div>
        <Typography.Title level={4}>设备摘要（最多 3 台）</Typography.Title>
        <Table<CustomerDevice>
          columns={[
            { key: 'device', title: '设备', render: (_, device) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{device.label ?? platformLabel(device.platform)}</Typography.Text>
                <Typography.Text className="secondary-id" type="secondary">{device.id}</Typography.Text>
              </Space>
            ) },
            { dataIndex: 'platform', title: '平台', width: 90, render: platformLabel },
            { dataIndex: 'status', title: '状态', width: 90, render: (value) => value === 'active' ? <Tag color="green">正常</Tag> : <Tag>已撤销</Tag> },
            { dataIndex: 'activeSessions', title: '活动会话', width: 100 },
            { dataIndex: 'lastSeenAt', title: '最近活动', width: 180, render: formatDateTime },
            { key: 'action', title: '操作', width: 100, render: (_, device) => canRevoke ? (
              <Button disabled={device.status === 'revoked'} size="small" onClick={() => onRevoke(record, device.id)}>撤销设备</Button>
            ) : <Typography.Text type="secondary">只读</Typography.Text> },
          ]}
          dataSource={record.devices}
          locale={{ emptyText: <Empty description="暂无设备" /> }}
          pagination={false}
          rowKey="id"
          size="small"
        />
      </div>
    </Space>
  );
}

function RetryAlert({ message: text, onRetry }: { message: string; onRetry(): void }) {
  return <Alert action={<Button size="small" onClick={onRetry}>重试</Button>} className="page-alert" message={text} showIcon type="error" />;
}

function StatusTag({ status }: { status: CustomerStatus }) {
  return status === 'active' ? <Tag color="green">正常</Tag> : <Tag>停用</Tag>;
}

function platformLabel(platform: CustomerDevice['platform']): string {
  return { android: 'Android', h5: 'H5', ios: 'iOS', web: 'Web' }[platform];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

async function confirmValidator(_: unknown, value: boolean): Promise<void> {
  if (!value) throw new Error('请先确认操作影响');
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}
