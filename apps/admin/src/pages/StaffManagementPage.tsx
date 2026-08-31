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
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

type StaffStatus = 'active' | 'disabled' | 'locked';

interface RoleSummary {
  id: string;
  isSystem: boolean;
  name: string;
  status: 'active' | 'disabled';
}

interface StaffRecord {
  createdAt: string;
  email?: string;
  id: string;
  phone?: string;
  roles: RoleSummary[];
  status: StaffStatus;
  updatedAt: string;
  username: string;
  version: number;
}

interface StaffListResponse {
  items: StaffRecord[];
  page: number;
  pageSize: number;
  total: number;
}

interface RoleRecord extends RoleSummary {
  version: number;
}

interface CreateForm {
  email?: string;
  password: string;
  phone?: string;
  roleId: string;
  username: string;
}

interface ProfileForm {
  clearEmail?: boolean;
  clearPhone?: boolean;
  email?: string;
  phone?: string;
  roleId?: string;
  username: string;
}

interface PasswordForm {
  confirmed: boolean;
  password: string;
  passwordAgain: string;
}

interface RevokeForm {
  confirmed: boolean;
  reason: string;
}

interface Props {
  accessApiBase: string;
  apiBase: string;
  managePermission: string;
  passwordResetPermission: string;
  readPermission: string;
  roleReadPermission: string;
  sessionRevokePermission: string;
  title: string;
}

const emptyList: StaffListResponse = { items: [], page: 1, pageSize: 20, total: 0 };

export function StaffManagementPage({
  accessApiBase,
  apiBase,
  managePermission,
  passwordResetPermission,
  readPermission,
  roleReadPermission,
  sessionRevokePermission,
  title,
}: Props) {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [createForm] = Form.useForm<CreateForm>();
  const [profileForm] = Form.useForm<ProfileForm>();
  const [passwordForm] = Form.useForm<PasswordForm>();
  const [revokeForm] = Form.useForm<RevokeForm>();
  const [list, setList] = useState(emptyList);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [roleError, setRoleError] = useState<string>();
  const [status, setStatus] = useState<StaffStatus>();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<StaffRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<StaffRecord>();
  const [passwordTarget, setPasswordTarget] = useState<StaffRecord>();
  const [revokeTarget, setRevokeTarget] = useState<StaffRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes(readPermission);
  const canManage = permissions.includes(managePermission);
  const canReadRoles = permissions.includes(roleReadPermission);
  const canResetPassword = permissions.includes(passwordResetPermission);
  const canRevokeSessions = permissions.includes(sessionRevokePermission);
  const activeRoles = roles.filter((role) => role.status === 'active');

  const load = useCallback(async (page = 1, pageSize = list.pageSize) => {
    if (!canRead) return;
    const sequence = ++listSequence.current;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) query.set('status', status);
    if (search) query.set('q', search);
    try {
      const result = await request<StaffListResponse>(`${apiBase}?${query}`);
      if (sequence === listSequence.current) setList(result);
    } catch (reason) {
      if (sequence === listSequence.current) setError(errorMessage(reason, '员工列表加载失败'));
    } finally {
      if (sequence === listSequence.current) setLoading(false);
    }
  }, [apiBase, canRead, list.pageSize, request, search, status]);

  const loadRoles = useCallback(async () => {
    if (!canReadRoles) return;
    setRolesLoading(true);
    setRoleError(undefined);
    try {
      setRoles(await request<RoleRecord[]>(`${accessApiBase}/roles`));
    } catch (reason) {
      setRoleError(errorMessage(reason, '角色列表加载失败'));
    } finally {
      setRolesLoading(false);
    }
  }, [accessApiBase, canReadRoles, request]);

  useEffect(() => { void load(1); }, [load]);
  useEffect(() => { void loadRoles(); }, [loadRoles]);

  async function openDetail(record: StaffRecord): Promise<void> {
    const sequence = ++detailSequence.current;
    setSelected(record);
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const detail = await request<StaffRecord>(`${apiBase}/${encodeURIComponent(record.id)}`);
      if (sequence === detailSequence.current) setSelected(detail);
    } catch (reason) {
      if (sequence === detailSequence.current) {
        setDetailError(errorMessage(reason, '员工详情加载失败'));
      }
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }

  function openCreate(): void {
    createForm.resetFields();
    createForm.setFieldsValue({ roleId: activeRoles[0]?.id });
    setCreateOpen(true);
  }

  async function create(values: CreateForm): Promise<void> {
    setSubmitting('create');
    try {
      await request(apiBase, {
        body: JSON.stringify({
          email: values.email?.trim() || undefined,
          password: values.password,
          phone: values.phone?.trim() || undefined,
          roleId: values.roleId,
          username: values.username.trim(),
        }),
        method: 'POST',
      });
      messageApi.success('员工账号已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await load(1, list.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '员工创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function openProfile(record: StaffRecord): void {
    profileForm.resetFields();
    profileForm.setFieldsValue({
      clearEmail: false,
      clearPhone: false,
      roleId: record.roles[0]?.id,
      username: record.username,
    });
    setProfileTarget(record);
  }

  async function saveProfile(values: ProfileForm): Promise<void> {
    if (!profileTarget) return;
    const payload: Record<string, unknown> = {
      username: values.username.trim(),
      version: profileTarget.version,
    };
    if (canReadRoles && values.roleId && profileTarget.id !== principal?.id) {
      payload.roleId = values.roleId;
    }
    if (values.clearEmail) payload.email = null;
    else if (values.email?.trim()) payload.email = values.email.trim();
    if (values.clearPhone) payload.phone = null;
    else if (values.phone?.trim()) payload.phone = values.phone.trim();
    setSubmitting(`profile:${profileTarget.id}`);
    try {
      await request(`${apiBase}/${encodeURIComponent(profileTarget.id)}/profile`, {
        body: JSON.stringify(payload),
        method: 'PATCH',
      });
      messageApi.success('员工资料已更新');
      setProfileTarget(undefined);
      await load(list.page, list.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '员工资料更新失败'));
      if (isConflict(reason)) {
        setProfileTarget(undefined);
        await load(list.page, list.pageSize);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function toggleStatus(record: StaffRecord): Promise<void> {
    const next = record.status === 'active' ? 'disabled' : 'active';
    setSubmitting(`status:${record.id}`);
    try {
      await request(`${apiBase}/${encodeURIComponent(record.id)}/status`, {
        body: JSON.stringify({ status: next, version: record.version }),
        method: 'PATCH',
      });
      messageApi.success(next === 'active' ? '员工已启用' : '员工已停用，会话已撤销');
      await load(list.page, list.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '员工状态更新失败'));
      if (isConflict(reason)) await load(list.page, list.pageSize);
    } finally {
      setSubmitting(undefined);
    }
  }

  function openPassword(record: StaffRecord): void {
    passwordForm.resetFields();
    passwordForm.setFieldsValue({ confirmed: false });
    setPasswordTarget(record);
  }

  async function resetPassword(values: PasswordForm): Promise<void> {
    if (!passwordTarget) return;
    setSubmitting(`password:${passwordTarget.id}`);
    try {
      await request(`${apiBase}/${encodeURIComponent(passwordTarget.id)}/reset-password`, {
        body: JSON.stringify({ password: values.password, version: passwordTarget.version }),
        method: 'POST',
      });
      messageApi.success('密码已重置，该员工的现有会话已全部撤销');
      setPasswordTarget(undefined);
      passwordForm.resetFields();
      await load(list.page, list.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '密码重置失败'));
      if (isConflict(reason)) {
        setPasswordTarget(undefined);
        await load(list.page, list.pageSize);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function openRevoke(record: StaffRecord): void {
    revokeForm.resetFields();
    revokeForm.setFieldsValue({ confirmed: false });
    setRevokeTarget(record);
  }

  async function revokeSessions(values: RevokeForm): Promise<void> {
    if (!revokeTarget) return;
    setSubmitting(`sessions:${revokeTarget.id}`);
    try {
      const response = await request<{ sessionsRevoked: number }>(
        `${apiBase}/${encodeURIComponent(revokeTarget.id)}/revoke-sessions`,
        { body: JSON.stringify({ reason: values.reason.trim() }), method: 'POST' },
      );
      messageApi.success(`已撤销 ${response.sessionsRevoked} 个活动会话`);
      setRevokeTarget(undefined);
      revokeForm.resetFields();
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
            联系方式默认脱敏；停用或重置密码会立即撤销该员工的活动会话。
          </Typography.Text>
        </div>
        {canManage ? (
          <Button
            disabled={!canReadRoles || activeRoles.length === 0}
            loading={rolesLoading}
            onClick={openCreate}
            type="primary"
          >
            创建员工
          </Button>
        ) : null}
      </div>

      {error ? <RetryAlert message={error} onRetry={() => void load(list.page, list.pageSize)} /> : null}
      {roleError ? <RetryAlert message={roleError} onRetry={() => void loadRoles()} /> : null}
      {canManage && !canReadRoles ? (
        <Alert className="page-alert" message="当前账号没有角色读取权限，不能创建员工或调整角色。" showIcon type="warning" />
      ) : null}
      <div className="audit-filter-card">
        <Space wrap>
          <Input.Search
            allowClear
            enterButton="搜索"
            placeholder="按用户名搜索"
            style={{ width: 320 }}
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              if (!event.target.value) setSearch('');
            }}
            onSearch={(value) => setSearch(value.trim())}
          />
          <Select
            allowClear
            options={[
              { label: '正常', value: 'active' },
              { label: '停用', value: 'disabled' },
              { label: '锁定', value: 'locked' },
            ]}
            placeholder="全部状态"
            style={{ width: 130 }}
            value={status}
            onChange={setStatus}
          />
          <Button loading={loading} onClick={() => void load(list.page, list.pageSize)}>刷新</Button>
        </Space>
      </div>
      <Table<StaffRecord>
        columns={[
          {
            key: 'account',
            title: '账号',
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Button className="table-link-button" type="link" onClick={() => void openDetail(record)}>
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
                <Typography.Text>{record.email ?? '—'}</Typography.Text>
                <Typography.Text>{record.phone ?? '—'}</Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'roles',
            title: '角色',
            render: (value: RoleSummary[]) => value.length ? (
              <Space size={[4, 4]} wrap>
                {value.map((role) => <Tag key={role.id}>{role.name}{role.status === 'disabled' ? '·停用' : ''}</Tag>)}
              </Space>
            ) : <Typography.Text type="danger">未分配</Typography.Text>,
          },
          { dataIndex: 'status', title: '状态', width: 90, render: (value) => <StatusTag status={value} /> },
          { dataIndex: 'updatedAt', title: '更新时间', width: 180, render: formatDateTime },
          {
            key: 'actions',
            title: '操作',
            width: 360,
            render: (_, record) => (
              <Space size={6} wrap>
                {canManage ? <Button size="small" onClick={() => openProfile(record)}>资料/角色</Button> : null}
                {canManage ? (
                  <Popconfirm
                    disabled={record.id === principal?.id}
                    onConfirm={() => void toggleStatus(record)}
                    title={record.status === 'active' ? '停用后将立即撤销全部会话，继续？' : '确认启用该员工？'}
                  >
                    <Button
                      disabled={record.id === principal?.id}
                      loading={submitting === `status:${record.id}`}
                      size="small"
                    >
                      {record.status === 'active' ? '停用' : '启用'}
                    </Button>
                  </Popconfirm>
                ) : null}
                {canResetPassword ? <Button size="small" onClick={() => openPassword(record)}>重置密码</Button> : null}
                {canRevokeSessions ? <Button size="small" onClick={() => openRevoke(record)}>撤销会话</Button> : null}
                {!canManage && !canResetPassword && !canRevokeSessions
                  ? <Typography.Text type="secondary">只读</Typography.Text>
                  : null}
              </Space>
            ),
          },
        ]}
        dataSource={list.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无员工账号" /> }}
        pagination={{
          current: list.page,
          onChange: (page, pageSize) => void load(page, pageSize),
          pageSize: list.pageSize,
          showSizeChanger: true,
          total: list.total,
        }}
        rowKey="id"
        scroll={{ x: 1250 }}
      />

      <Drawer
        destroyOnHidden
        loading={detailLoading}
        onClose={() => {
          detailSequence.current += 1;
          setSelected(undefined);
          setDetailError(undefined);
        }}
        open={Boolean(selected)}
        title="员工详情"
        width={680}
      >
        {detailError ? (
          <RetryAlert message={detailError} onRetry={() => selected && void openDetail(selected)} />
        ) : selected ? <StaffDetail record={selected} /> : null}
      </Drawer>

      <Modal
        confirmLoading={submitting === 'create'}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="创建员工账号"
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => void create(values)}>
          <AccountFields roles={activeRoles} />
          <Form.Item label="初始密码" name="password" rules={[{ min: 12, max: 4096, required: true }]}>
            <Input.Password autoComplete="new-password" maxLength={4096} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        confirmLoading={Boolean(profileTarget && submitting === `profile:${profileTarget.id}`)}
        onCancel={() => setProfileTarget(undefined)}
        onOk={() => profileForm.submit()}
        open={Boolean(profileTarget)}
        title="修改员工资料与角色"
      >
        <Form form={profileForm} layout="vertical" onFinish={(values) => void saveProfile(values)}>
          <Form.Item label="用户名" name="username" rules={[{ min: 3, max: 64, required: true, whitespace: true }]}>
            <Input maxLength={64} />
          </Form.Item>
          {canReadRoles ? (
            <Form.Item label="单一角色" name="roleId" rules={[{ required: true }]}>
              <Select
                disabled={profileTarget?.id === principal?.id}
                options={roleOptions(activeRoles)}
              />
            </Form.Item>
          ) : null}
          <Form.Item extra={`当前：${profileTarget?.email ?? '未设置'}；留空表示不修改。`} label="新邮箱" name="email" rules={[{ type: 'email' }]}>
            <Input maxLength={320} />
          </Form.Item>
          <Form.Item name="clearEmail" valuePropName="checked"><Checkbox>清除邮箱</Checkbox></Form.Item>
          <Form.Item extra={`当前：${profileTarget?.phone ?? '未设置'}；留空表示不修改。`} label="新手机号" name="phone" rules={[{ pattern: /^\+[1-9][0-9]{7,14}$/, message: '请输入 E.164 手机号' }]}>
            <Input maxLength={16} placeholder="+12025550123" />
          </Form.Item>
          <Form.Item name="clearPhone" valuePropName="checked"><Checkbox>清除手机号</Checkbox></Form.Item>
        </Form>
      </Modal>

      <Modal destroyOnHidden footer={null} onCancel={() => setPasswordTarget(undefined)} open={Boolean(passwordTarget)} title="重置员工密码">
        <Alert className="page-alert" message="提交后该员工的现有登录会话会全部失效。" showIcon type="warning" />
        <Form form={passwordForm} layout="vertical" onFinish={(values) => void resetPassword(values)}>
          <Form.Item label="新密码" name="password" rules={[{ min: 12, max: 4096, required: true }]}>
            <Input.Password autoComplete="new-password" maxLength={4096} />
          </Form.Item>
          <Form.Item
            dependencies={['password']}
            label="再次输入"
            name="passwordAgain"
            rules={[
              { required: true },
              ({ getFieldValue }) => ({ validator: async (_, value) => {
                if (value !== getFieldValue('password')) throw new Error('两次密码不一致');
              } }),
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={4096} />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmValidator }]} valuePropName="checked">
            <Checkbox>我确认重置密码并撤销该员工全部会话</Checkbox>
          </Form.Item>
          <Button block htmlType="submit" loading={Boolean(passwordTarget && submitting === `password:${passwordTarget.id}`)} type="primary">确认重置</Button>
        </Form>
      </Modal>

      <Modal destroyOnHidden footer={null} onCancel={() => setRevokeTarget(undefined)} open={Boolean(revokeTarget)} title="撤销员工会话">
        <Form form={revokeForm} layout="vertical" onFinish={(values) => void revokeSessions(values)}>
          <Form.Item label="撤销原因" name="reason" rules={[{ max: 200, required: true, whitespace: true }]}>
            <Input.TextArea maxLength={200} rows={3} showCount />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmValidator }]} valuePropName="checked">
            <Checkbox>我确认让该员工当前所有设备退出登录</Checkbox>
          </Form.Item>
          <Button block danger htmlType="submit" loading={Boolean(revokeTarget && submitting === `sessions:${revokeTarget.id}`)} type="primary">确认撤销</Button>
        </Form>
      </Modal>
    </>
  );
}

function AccountFields({ roles }: { roles: RoleSummary[] }) {
  return (
    <>
      <Form.Item label="用户名" name="username" rules={[{ min: 3, max: 64, required: true, whitespace: true }]}>
        <Input autoComplete="off" maxLength={64} />
      </Form.Item>
      <Form.Item label="邮箱（可选）" name="email" rules={[{ type: 'email' }]}>
        <Input autoComplete="off" maxLength={320} />
      </Form.Item>
      <Form.Item label="手机号（可选）" name="phone" rules={[{ pattern: /^\+[1-9][0-9]{7,14}$/, message: '请输入 E.164 手机号' }]}>
        <Input autoComplete="off" maxLength={16} placeholder="+12025550123" />
      </Form.Item>
      <Form.Item label="单一角色" name="roleId" rules={[{ required: true }]}>
        <Select options={roleOptions(roles)} />
      </Form.Item>
    </>
  );
}

function StaffDetail({ record }: { record: StaffRecord }) {
  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="员工 ID"><Typography.Text copyable>{record.id}</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="用户名">{record.username}</Descriptions.Item>
      <Descriptions.Item label="邮箱（脱敏）">{record.email ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="手机号（脱敏）">{record.phone ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="状态"><StatusTag status={record.status} /></Descriptions.Item>
      <Descriptions.Item label="角色">
        {record.roles.length ? record.roles.map((role) => <Tag key={role.id}>{role.name}</Tag>) : '未分配'}
      </Descriptions.Item>
      <Descriptions.Item label="版本">{record.version}</Descriptions.Item>
      <Descriptions.Item label="创建时间">{formatDateTime(record.createdAt)}</Descriptions.Item>
      <Descriptions.Item label="更新时间">{formatDateTime(record.updatedAt)}</Descriptions.Item>
    </Descriptions>
  );
}

function RetryAlert({ message: text, onRetry }: { message: string; onRetry(): void }) {
  return <Alert action={<Button size="small" onClick={onRetry}>重试</Button>} className="page-alert" message={text} showIcon type="error" />;
}

function StatusTag({ status }: { status: StaffStatus }) {
  const option = {
    active: { color: 'green', text: '正常' },
    disabled: { color: undefined, text: '停用' },
    locked: { color: 'red', text: '锁定' },
  }[status];
  return <Tag color={option.color}>{option.text}</Tag>;
}

function roleOptions(roles: RoleSummary[]) {
  return roles.map((role) => ({
    label: `${role.name}${role.isSystem ? '（系统）' : ''}`,
    value: role.id,
  }));
}

async function confirmValidator(_: unknown, value: boolean) {
  if (value !== true) throw new Error('请先勾选确认');
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function isConflict(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 409;
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) {
    return reason.status === 409 ? `${reason.message}，已刷新最新数据，请重新操作` : reason.message;
  }
  return fallback;
}
