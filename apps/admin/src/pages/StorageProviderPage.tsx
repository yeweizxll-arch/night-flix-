import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

interface StorageProviderRecord {
  bucket: string;
  cdnBaseUrl?: string;
  createdAt: string;
  credentialConfigured: true;
  endpoint?: string;
  forcePathStyle: boolean;
  id: string;
  label: string;
  ownerType: 'platform' | 'tenant';
  provider: 's3';
  readOnly: boolean;
  region: string;
  status: 'active' | 'disabled';
  updatedAt: string;
  version: number;
}

interface StorageProviderListResponse {
  items: StorageProviderRecord[];
  page: number;
  pageSize: number;
  total: number;
}

interface StorageProviderForm {
  accessKeyId?: string;
  bucket: string;
  cdnBaseUrl?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  label: string;
  region: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

const emptyData: StorageProviderListResponse = {
  items: [],
  page: 1,
  pageSize: 20,
  total: 0,
};

interface StorageProviderPageProps {
  apiBase: string;
  description: string;
  managePermission: string;
  title: string;
}

export function StorageProviderPage({
  apiBase,
  description,
  managePermission,
  title,
}: StorageProviderPageProps) {
  const { principal, request } = useAuth();
  const [form] = Form.useForm<StorageProviderForm>();
  const [messageApi, messageContext] = message.useMessage();
  const [data, setData] = useState(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<'create' | StorageProviderRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const loadSequence = useRef(0);
  const pageSizeRef = useRef(20);

  const canManage = principal?.permissions.includes(managePermission) ?? false;

  const load = useCallback(async (
    page = 1,
    pageSize = pageSizeRef.current,
  ) => {
    const sequence = ++loadSequence.current;
    pageSizeRef.current = pageSize;
    setLoading(true);
    setError(undefined);
    try {
      const result = await request<StorageProviderListResponse>(
        `${apiBase}?page=${page}&pageSize=${pageSize}`,
      );
      if (sequence === loadSequence.current) setData(result);
    } catch (reason) {
      if (sequence === loadSequence.current) {
        setError(errorMessage(reason, '对象存储配置加载失败'));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [apiBase, request]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate(): void {
    form.resetFields();
    form.setFieldsValue({ forcePathStyle: false, region: 'ap-northeast-1' });
    setEditor('create');
  }

  function openEdit(provider: StorageProviderRecord): void {
    form.resetFields();
    form.setFieldsValue({
      bucket: provider.bucket,
      cdnBaseUrl: provider.cdnBaseUrl,
      endpoint: provider.endpoint,
      forcePathStyle: provider.forcePathStyle,
      label: provider.label,
      region: provider.region,
    });
    setEditor(provider);
  }

  function closeEditor(): void {
    if (submitting) return;
    setEditor(undefined);
    form.resetFields();
  }

  async function save(values: StorageProviderForm): Promise<void> {
    const isCreate = editor === 'create';
    const target = isCreate ? undefined : editor;
    const accessKeyId = optionalTrim(values.accessKeyId);
    const secretAccessKey = optionalRaw(values.secretAccessKey);
    const sessionToken = optionalRaw(values.sessionToken);
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      messageApi.error('Access Key ID 和 Secret Access Key 必须同时填写');
      return;
    }
    if (isCreate && (!accessKeyId || !secretAccessKey)) {
      messageApi.error('创建存储配置时必须填写完整凭据');
      return;
    }
    if (!accessKeyId && sessionToken) {
      messageApi.error('会话令牌只能随整组凭据一起替换');
      return;
    }
    const actionKey = isCreate ? 'create' : `edit:${target!.id}`;
    setSubmitting(actionKey);
    try {
      const payload: Record<string, unknown> = {
        bucket: values.bucket.trim(),
        cdnBaseUrl: optionalTrim(values.cdnBaseUrl) ?? '',
        endpoint: optionalTrim(values.endpoint) ?? '',
        forcePathStyle: values.forcePathStyle,
        label: values.label.trim(),
        provider: 's3',
        region: values.region.trim(),
      };
      if (accessKeyId && secretAccessKey) {
        payload.accessKeyId = accessKeyId;
        payload.secretAccessKey = secretAccessKey;
        payload.sessionToken = sessionToken ?? '';
      }
      if (target) payload.version = target.version;
      await request<StorageProviderRecord>(
        target ? `${apiBase}/${encodeURIComponent(target.id)}` : apiBase,
        {
          body: JSON.stringify(payload),
          method: target ? 'PATCH' : 'POST',
        },
      );
      messageApi.success(target ? '对象存储配置已更新' : '对象存储配置已创建');
      setEditor(undefined);
      form.resetFields();
      await load(target ? data.page : 1, data.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, target ? '对象存储更新失败' : '对象存储创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function changeStatus(provider: StorageProviderRecord): Promise<void> {
    const actionKey = `status:${provider.id}`;
    setSubmitting(actionKey);
    try {
      await request<StorageProviderRecord>(
        `${apiBase}/${encodeURIComponent(provider.id)}/status`,
        {
          body: JSON.stringify({
            status: provider.status === 'active' ? 'disabled' : 'active',
            version: provider.version,
          }),
          method: 'PATCH',
        },
      );
      messageApi.success(provider.status === 'active' ? '存储配置已停用' : '存储配置已启用');
      await load(data.page, data.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '存储状态修改失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function deleteProvider(provider: StorageProviderRecord): Promise<void> {
    const actionKey = `delete:${provider.id}`;
    setSubmitting(actionKey);
    try {
      await request(`${apiBase}/${encodeURIComponent(provider.id)}`, {
        body: JSON.stringify({ version: provider.version }),
        method: 'DELETE',
      });
      messageApi.success('对象存储配置已删除');
      const nextPage = data.items.length === 1 && data.page > 1 ? data.page - 1 : data.page;
      await load(nextPage, data.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '对象存储删除失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  const editorTarget = editor && editor !== 'create' ? editor : undefined;
  const columns = useMemo(() => [
    {
      dataIndex: 'label',
      title: '存储配置',
      render: (label: string, provider: StorageProviderRecord) => (
        <Space direction="vertical" size={0}>
          <Space size={6} wrap>
            <Typography.Text strong>{label}</Typography.Text>
            {provider.readOnly ? <Tag color="blue">公共·只读</Tag> : null}
          </Space>
          <Typography.Text className="secondary-id" copyable type="secondary">
            {provider.id}
          </Typography.Text>
        </Space>
      ),
    },
    {
      key: 'target',
      title: '存储目标',
      render: (_: unknown, provider: StorageProviderRecord) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{provider.bucket}</Typography.Text>
          <Typography.Text type="secondary">
            {provider.endpoint ?? 'AWS S3 默认端点'}
          </Typography.Text>
        </Space>
      ),
    },
    { dataIndex: 'region', title: '区域', width: 140 },
    {
      key: 'credentials',
      title: '凭据',
      width: 105,
      render: (_: unknown, provider: StorageProviderRecord) => provider.credentialConfigured
        ? <Tag color="green">已配置</Tag>
        : <Tag color="red">未配置</Tag>,
    },
    {
      dataIndex: 'status',
      title: '状态',
      width: 95,
      render: (status: StorageProviderRecord['status']) => status === 'active'
        ? <Tag color="green">启用</Tag>
        : <Tag>停用</Tag>,
    },
    {
      dataIndex: 'updatedAt',
      title: '更新时间',
      width: 180,
      render: formatDateTime,
    },
    {
      fixed: 'right' as const,
      key: 'actions',
      title: '操作',
      width: 240,
      render: (_: unknown, provider: StorageProviderRecord) => {
        if (!canManage || provider.readOnly) {
          return <Typography.Text type="secondary">只读</Typography.Text>;
        }
        const rowBusy = submitting?.endsWith(`:${provider.id}`) ?? false;
        return (
          <Space size={6} wrap>
            <Button disabled={rowBusy} size="small" onClick={() => openEdit(provider)}>
              编辑
            </Button>
            <Popconfirm
              description={provider.status === 'active'
                ? '停用后不能再用于新的上传。'
                : '启用后可用于新的上传。'}
              okButtonProps={{ loading: submitting === `status:${provider.id}` }}
              onConfirm={() => void changeStatus(provider)}
              title={provider.status === 'active' ? '停用该存储配置？' : '启用该存储配置？'}
            >
              <Button disabled={rowBusy} size="small">
                {provider.status === 'active' ? '停用' : '启用'}
              </Button>
            </Popconfirm>
            <Popconfirm
              description="已被媒体引用的存储配置无法删除。"
              okButtonProps={{ danger: true, loading: submitting === `delete:${provider.id}` }}
              onConfirm={() => void deleteProvider(provider)}
              title="删除该存储配置？"
            >
              <Button danger disabled={rowBusy} size="small">删除</Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ], [canManage, submitting]);

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </div>
        {canManage ? <Button type="primary" onClick={openCreate}>创建 S3 配置</Button> : null}
      </div>

      <Alert
        className="page-alert"
        description="Access Key、Secret Key 和会话令牌只在创建或主动替换时提交，保存后不会在页面或接口中回显。"
        message="存储凭据已加密保管"
        showIcon
        type="info"
      />

      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load(data.page, data.pageSize)}>重试</Button>}
          className="page-alert"
          closable
          message={error}
          onClose={() => setError(undefined)}
          showIcon
          type="error"
        />
      ) : null}

      <Table<StorageProviderRecord>
        columns={columns}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无对象存储配置" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: (page, pageSize) => void load(page, pageSize),
          pageSize: data.pageSize,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1250 }}
      />

      <StorageProviderModal
        form={form}
        loading={submitting === (editor === 'create' ? 'create' : `edit:${editorTarget?.id}`)}
        onCancel={closeEditor}
        onFinish={(values) => void save(values)}
        open={Boolean(editor)}
        target={editorTarget}
      />
    </>
  );
}

function StorageProviderModal({
  form,
  loading,
  onCancel,
  onFinish,
  open,
  target,
}: {
  form: ReturnType<typeof Form.useForm<StorageProviderForm>>[0];
  loading: boolean;
  onCancel(): void;
  onFinish(values: StorageProviderForm): void;
  open: boolean;
  target?: StorageProviderRecord;
}) {
  return (
    <Modal
      cancelText="取消"
      destroyOnHidden
      okText={target ? '保存修改' : '创建配置'}
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={open}
      title={target ? `编辑存储·${target.label}` : '创建 S3 对象存储'}
      width={760}
    >
      <Form<StorageProviderForm>
        form={form}
        layout="vertical"
        onFinish={onFinish}
        requiredMark={false}
      >
        <div className="two-column-form">
          <Form.Item label="配置名称" name="label" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="Bucket" name="bucket" rules={[
            { required: true, message: '请输入 Bucket' },
            { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,253}[A-Za-z0-9]$/, message: 'Bucket 格式不正确' },
          ]}>
            <Input maxLength={255} />
          </Form.Item>
          <Form.Item label="Region" name="region" rules={[
            { required: true, message: '请输入 Region' },
            { pattern: /^[A-Za-z0-9._-]{1,100}$/, message: 'Region 格式不正确' },
          ]}>
            <Input maxLength={100} placeholder="ap-northeast-1" />
          </Form.Item>
          <Form.Item label="强制 Path Style" name="forcePathStyle" valuePropName="checked">
            <Switch checkedChildren="开" unCheckedChildren="关" />
          </Form.Item>
        </div>
        <Form.Item
          extra="留空表示使用 AWS S3 默认端点；自定义端点必须是无凭据、无路径的公网 HTTPS Origin"
          label="S3 兼容端点（可选）"
          name="endpoint"
          rules={[{ message: '请输入 HTTPS Origin', pattern: /^https:\/\/[^/?#]+\/?$/i }]}
        >
          <Input maxLength={2048} placeholder="https://objects.example.com" />
        </Form.Item>
        <Form.Item
          extra="只允许公网 HTTPS Origin，不允许路径、参数或账号密码"
          label="CDN 基础地址（可选）"
          name="cdnBaseUrl"
          rules={[{ message: '请输入 HTTPS Origin', pattern: /^https:\/\/[^/?#]+\/?$/i }]}
        >
          <Input maxLength={2048} placeholder="https://cdn.example.com" />
        </Form.Item>

        <Typography.Title className="form-section-title" level={5}>
          {target ? '替换凭据（可选）' : '存储凭据'}
        </Typography.Title>
        {target ? (
          <Alert
            className="page-alert"
            message="当前凭据已配置，不会回显。如需轮换，请同时填写新的 Access Key ID 和 Secret Access Key。"
            showIcon
            type="warning"
          />
        ) : null}
        <div className="two-column-form">
          <Form.Item label="Access Key ID" name="accessKeyId" rules={target ? [] : [{ required: true }]}>
            <Input autoComplete="off" maxLength={256} />
          </Form.Item>
          <Form.Item label="Secret Access Key" name="secretAccessKey" rules={target ? [] : [{ required: true }]}>
            <Input.Password autoComplete="new-password" maxLength={512} />
          </Form.Item>
        </div>
        <Form.Item label="Session Token（可选）" name="sessionToken">
          <Input.Password autoComplete="new-password" maxLength={8192} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function optionalTrim(value?: string): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function optionalRaw(value?: string): string | undefined {
  return value || undefined;
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
