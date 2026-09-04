import {
  Alert,
  Button,
  Checkbox,
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
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

interface PermissionDirectoryItem {
  action: string;
  code: string;
  module: string;
  scope: 'platform' | 'tenant';
}

interface RolePermissionGrant {
  code: string;
  dataScope: 'all';
}

interface RoleRecord {
  id: string;
  isSystem: boolean;
  name: string;
  permissions: RolePermissionGrant[];
  status: 'active' | 'disabled';
  version: number;
}

interface CreateRoleFormValues {
  name: string;
  permissionCodes: string[];
}

interface EditRoleFormValues {
  name: string;
  status: RoleRecord['status'];
}

interface PermissionFormValues {
  permissionCodes: string[];
}

const moduleLabels: Record<string, string> = {
  commerce: '交易与商品',
  content: '内容审核',
  finance: '财务',
  notification: '消息推送',
  platform: '平台管理',
  storage: '对象存储',
  tenant: '代理商管理',
};

const actionLabels: Record<string, string> = {
  approve: '通过',
  confirm_transfer: '确认转账',
  create: '创建',
  export: '导出',
  manage: '管理',
  payout_account_read: '查看收款账户',
  read: '查看',
  reject: '驳回',
  review: '审核',
  status: '状态管理',
  submit: '提交',
  update: '修改',
};

export function RoleManagementPage({
  apiBase,
  description,
  managePermission,
  title,
}: {
  apiBase: string;
  description: string;
  managePermission: string;
  title: string;
}) {
  const { principal, request } = useAuth();
  const [createForm] = Form.useForm<CreateRoleFormValues>();
  const [editForm] = Form.useForm<EditRoleFormValues>();
  const [permissionForm] = Form.useForm<PermissionFormValues>();
  const [messageApi, messageContext] = message.useMessage();
  const [permissions, setPermissions] = useState<PermissionDirectoryItem[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [submitting, setSubmitting] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RoleRecord>();
  const [permissionTarget, setPermissionTarget] = useState<RoleRecord>();

  const canManage = principal?.permissions.includes(managePermission) ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(undefined);
    try {
      const [permissionResult, roleResult] = await Promise.all([
        request<PermissionDirectoryItem[]>(`${apiBase}/permissions`),
        request<RoleRecord[]>(`${apiBase}/roles`),
      ]);
      setPermissions(permissionResult);
      setRoles(roleResult);
    } catch (reason) {
      setLoadError(errorMessage(reason, '角色权限数据加载失败'));
    } finally {
      setLoading(false);
    }
  }, [apiBase, request]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createRole(values: CreateRoleFormValues): Promise<void> {
    setSubmitting('create');
    try {
      await request<RoleRecord>(`${apiBase}/roles`, {
        body: JSON.stringify({
          name: values.name.trim(),
          permissions: grants(values.permissionCodes ?? []),
        }),
        method: 'POST',
      });
      messageApi.success('角色已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '角色创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function updateRole(values: EditRoleFormValues): Promise<void> {
    if (!editTarget) {
      return;
    }
    setSubmitting(`edit:${editTarget.id}`);
    try {
      await request<RoleRecord>(
        `${apiBase}/roles/${encodeURIComponent(editTarget.id)}`,
        {
          body: JSON.stringify({
            name: values.name.trim(),
            status: values.status,
            version: editTarget.version,
          }),
          method: 'PATCH',
        },
      );
      messageApi.success('角色信息已更新');
      setEditTarget(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '角色更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function replacePermissions(values: PermissionFormValues): Promise<void> {
    if (!permissionTarget) {
      return;
    }
    setSubmitting(`permissions:${permissionTarget.id}`);
    try {
      await request<RoleRecord>(
        `${apiBase}/roles/${encodeURIComponent(permissionTarget.id)}/permissions`,
        {
          body: JSON.stringify({
            permissions: grants(values.permissionCodes ?? []),
            version: permissionTarget.version,
          }),
          method: 'PUT',
        },
      );
      messageApi.success('角色权限已替换');
      setPermissionTarget(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '权限保存失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function openEdit(role: RoleRecord): void {
    editForm.setFieldsValue({ name: role.name, status: role.status });
    setEditTarget(role);
  }

  function openPermissions(role: RoleRecord): void {
    permissionForm.setFieldsValue({
      permissionCodes: role.permissions.map((permission) => permission.code),
    });
    setPermissionTarget(role);
  }

  const roleTable = (
    <Table<RoleRecord>
      columns={[
        {
          dataIndex: 'name',
          title: '角色',
          render: (name: string, role) => (
            <Space direction="vertical" size={0}>
              <Space size={6}>
                <Typography.Text strong>{name}</Typography.Text>
                {role.isSystem ? <Tag>系统</Tag> : <Tag color="blue">自定义</Tag>}
              </Space>
              <Typography.Text type="secondary">版本 {role.version}</Typography.Text>
            </Space>
          ),
        },
        {
          dataIndex: 'status',
          title: '状态',
          width: 110,
          render: (status: RoleRecord['status']) => status === 'active'
            ? <Tag color="green">启用</Tag>
            : <Tag>已停用</Tag>,
        },
        {
          dataIndex: 'permissions',
          title: '权限',
          render: (rolePermissions: RolePermissionGrant[]) => (
            rolePermissions.length ? (
              <Space size={[4, 4]} wrap>
                {rolePermissions.slice(0, 4).map((permission) => (
                  <Tag key={permission.code}>{permission.code}</Tag>
                ))}
                {rolePermissions.length > 4 ? <Tag>+{rolePermissions.length - 4}</Tag> : null}
              </Space>
            ) : <Typography.Text type="secondary">无权限</Typography.Text>
          ),
        },
        {
          key: 'actions',
          title: '操作',
          width: canManage ? 180 : 90,
          render: (_, role) => (
            <Space size={6}>
              <Button size="small" onClick={() => openPermissions(role)}>
                {canManage && !role.isSystem ? '配置权限' : '查看权限'}
              </Button>
              {canManage && !role.isSystem ? (
                <Button size="small" onClick={() => openEdit(role)}>
                  编辑
                </Button>
              ) : null}
            </Space>
          ),
        },
      ]}
      dataSource={roles}
      loading={loading}
      locale={{ emptyText: <Empty description="暂无角色" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={false}
      rowKey="id"
      scroll={{ x: 900 }}
    />
  );

  const directoryTable = (
    <Table<PermissionDirectoryItem>
      columns={[
        {
          dataIndex: 'code',
          title: '权限代码',
          render: (code: string) => <Typography.Text code>{code}</Typography.Text>,
        },
        {
          dataIndex: 'module',
          title: '模块',
          render: (module: string) => moduleLabels[module] ?? module,
        },
        {
          dataIndex: 'action',
          title: '操作',
          render: (action: string) => actionLabels[action] ?? action,
        },
        {
          key: 'dataScope',
          title: '数据范围',
          render: () => <Tag color="blue">all / 全部</Tag>,
        },
      ]}
      dataSource={permissions}
      loading={loading}
      pagination={false}
      rowKey="code"
    />
  );

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </div>
        <Space>
          <Button loading={loading} onClick={() => void load()}>刷新</Button>
          {canManage ? (
            <Button type="primary" onClick={() => setCreateOpen(true)}>创建角色</Button>
          ) : null}
        </Space>
      </div>

      {loadError ? (
        <Alert
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
          className="page-alert"
          closable
          message={loadError}
          onClose={() => setLoadError(undefined)}
          showIcon
          type="error"
        />
      ) : null}

      <Tabs
        items={[
          { children: roleTable, key: 'roles', label: `角色列表 (${roles.length})` },
          { children: directoryTable, key: 'permissions', label: `权限目录 (${permissions.length})` },
        ]}
      />

      <Modal
        cancelText="取消"
        destroyOnHidden
        okText="创建"
        confirmLoading={submitting === 'create'}
        onCancel={() => {
          if (!submitting) {
            setCreateOpen(false);
            createForm.resetFields();
          }
        }}
        onOk={() => createForm.submit()}
        open={createOpen}
        title="创建角色"
        width={760}
      >
        <Form<CreateRoleFormValues>
          form={createForm}
          initialValues={{ permissionCodes: [] }}
          layout="vertical"
          onFinish={(values) => void createRole(values)}
          requiredMark={false}
        >
          <Form.Item
            label="角色名称"
            name="name"
            rules={[
              { required: true, message: '请输入角色名称', whitespace: true },
              { max: 100, message: '最多 100 字' },
            ]}
          >
            <Input maxLength={100} placeholder="例如：内容运营" />
          </Form.Item>
          <Form.Item label="初始权限" name="permissionCodes">
            <PermissionSelector permissions={permissions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        cancelText="取消"
        destroyOnHidden
        okText="保存"
        confirmLoading={submitting === `edit:${editTarget?.id}`}
        onCancel={() => {
          if (!submitting) {
            setEditTarget(undefined);
          }
        }}
        onOk={() => editForm.submit()}
        open={Boolean(editTarget)}
        title="编辑角色"
      >
        <Form<EditRoleFormValues>
          form={editForm}
          layout="vertical"
          onFinish={(values) => void updateRole(values)}
          requiredMark={false}
        >
          <Form.Item
            label="角色名称"
            name="name"
            rules={[
              { required: true, message: '请输入角色名称', whitespace: true },
              { max: 100, message: '最多 100 字' },
            ]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select options={[
              { label: '启用', value: 'active' },
              { label: '停用', value: 'disabled' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        cancelText="关闭"
        destroyOnHidden
        footer={canManage && !permissionTarget?.isSystem ? undefined : (
          <Button onClick={() => setPermissionTarget(undefined)}>关闭</Button>
        )}
        okText="原子替换权限"
        confirmLoading={submitting === `permissions:${permissionTarget?.id}`}
        onCancel={() => {
          if (!submitting) {
            setPermissionTarget(undefined);
          }
        }}
        onOk={() => permissionForm.submit()}
        open={Boolean(permissionTarget)}
        title={`角色权限 · ${permissionTarget?.name ?? ''}`}
        width={780}
      >
        {permissionTarget?.isSystem ? (
          <Alert
            className="page-alert"
            message="系统角色为保护性只读，不能替换权限。"
            showIcon
            type="info"
          />
        ) : null}
        <Form<PermissionFormValues>
          disabled={!canManage || permissionTarget?.isSystem}
          form={permissionForm}
          layout="vertical"
          onFinish={(values) => void replacePermissions(values)}
        >
          <Form.Item name="permissionCodes">
            <PermissionSelector permissions={permissions} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function PermissionSelector({
  onChange,
  permissions,
  value = [],
}: {
  onChange?: (value: string[]) => void;
  permissions: PermissionDirectoryItem[];
  value?: string[];
}) {
  const groups = useMemo(() => {
    const grouped = new Map<string, PermissionDirectoryItem[]>();
    for (const permission of permissions) {
      const items = grouped.get(permission.module) ?? [];
      items.push(permission);
      grouped.set(permission.module, items);
    }
    return [...grouped.entries()];
  }, [permissions]);

  if (!groups.length) {
    return <Empty description="权限目录为空" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Checkbox.Group
      className="permission-selector"
      onChange={(selected) => onChange?.(selected.map(String))}
      value={value}
    >
      {groups.map(([module, items]) => (
        <div className="permission-group" key={module}>
          <Typography.Text strong>{moduleLabels[module] ?? module}</Typography.Text>
          <div className="permission-options">
            {items.map((permission) => (
              <Checkbox key={permission.code} value={permission.code}>
                <span className="permission-option-label">
                  <span>{actionLabels[permission.action] ?? permission.action}</span>
                  <Typography.Text type="secondary">{permission.code}</Typography.Text>
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      ))}
    </Checkbox.Group>
  );
}

function grants(permissionCodes: string[]): RolePermissionGrant[] {
  return [...new Set(permissionCodes)].map((code) => ({ code, dataScope: 'all' }));
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
