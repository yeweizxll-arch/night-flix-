import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { auditActionLabel, auditResourceLabel, snapshotRows } from './audit-snapshot-ui';

type ActorType = 'platform_staff' | 'system' | 'tenant_staff' | 'user';

interface AuditLogRecord {
  action: string;
  actor: { id: string | null; type: ActorType };
  after: unknown;
  before: unknown;
  createdAt: string;
  id: string;
  requestId: string;
  resource: { id: string | null; type: string };
  scope: 'platform' | 'tenant';
  tenantId: string | null;
}

interface AuditLogPageResponse {
  items: AuditLogRecord[];
  page: number;
  pageSize: number;
  total: number;
}

interface AuditFilterForm {
  action?: string;
  actorId?: string;
  actorType?: ActorType;
  q?: string;
  requestId?: string;
  resourceId?: string;
  resourceType?: string;
  tenantId?: string;
  timeRange?: [DateValue, DateValue];
}

interface DateValue {
  toISOString(): string;
}

interface AuditLogPageProps {
  allowTenantFilter: boolean;
  apiBase: string;
  description: string;
  title: string;
}

const emptyData: AuditLogPageResponse = { items: [], page: 1, pageSize: 20, total: 0 };
const actorLabels: Record<ActorType, string> = {
  platform_staff: '平台员工',
  system: '系统',
  tenant_staff: '代理商员工',
  user: '用户',
};
const uuidRule = {
  message: '请输入有效 UUID',
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
};

export function AuditLogPage({
  allowTenantFilter,
  apiBase,
  description,
  title,
}: AuditLogPageProps) {
  const { request } = useAuth();
  const [form] = Form.useForm<AuditFilterForm>();
  const [data, setData] = useState(emptyData);
  const [filters, setFilters] = useState<AuditFilterForm>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<AuditLogRecord>();
  const pageSizeRef = useRef(20);
  const requestSequence = useRef(0);

  const load = useCallback(async (page = 1, pageSize = pageSizeRef.current) => {
    const sequence = ++requestSequence.current;
    pageSizeRef.current = Math.min(100, Math.max(1, pageSize));
    setLoading(true);
    setError(undefined);
    const query = buildQuery(filters, page, pageSizeRef.current, allowTenantFilter);
    try {
      const result = await request<AuditLogPageResponse>(`${apiBase}?${query}`);
      if (sequence === requestSequence.current) setData(result);
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(errorMessage(reason, '审计日志加载失败'));
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [allowTenantFilter, apiBase, filters, request]);

  useEffect(() => {
    void load(1);
  }, [load]);

  function applyFilters(values: AuditFilterForm): void {
    setFilters(normalizeFilters(values, allowTenantFilter));
  }

  function resetFilters(): void {
    form.resetFields();
    setFilters({});
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">{description}</Typography.Text>
        </div>
      </div>

      <Alert
        className="page-alert"
        message="记录员工操作及变更内容，敏感信息已隐藏。"
        showIcon
        type="info"
      />

      <Form<AuditFilterForm>
        name="auditlogpage-1" className="audit-filter-card"
        form={form}
        layout="vertical"
        onFinish={applyFilters}
      >
        <div className="audit-filter-grid">
          <Form.Item
            extra="未选择时查询最近 30 天，单次最多 90 天。"
            label="时间范围"
            name="timeRange"
            rules={[{
              validator: async (_, range?: [DateValue, DateValue]) => {
                if (!range) return;
                const from = Date.parse(range[0].toISOString());
                const to = Date.parse(range[1].toISOString());
                if (from > to || to - from > 90 * 24 * 60 * 60 * 1_000) {
                  throw new Error('时间范围不能超过 90 天');
                }
              },
            }]}
          >
            <DatePicker.RangePicker
              showTime
              style={{ width: '100%' }}
            />
          </Form.Item>
          <Form.Item
            label="操作类型"
            name="action"
            rules={[{
              message: 'Action 格式不正确',
              pattern: /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/,
            }]}
          >
            <Input allowClear maxLength={200} placeholder="commerce.order.create" />
          </Form.Item>
          <Form.Item label="执行人类型" name="actorType">
            <Select
              allowClear
              options={Object.entries(actorLabels).map(([value, label]) => ({ label, value }))}
            />
          </Form.Item>
          <Form.Item label="执行人编号" name="actorId" rules={[uuidRule]}>
            <Input allowClear maxLength={36} />
          </Form.Item>
          <Form.Item
            label="资源类型"
            name="resourceType"
            rules={[{
              message: '资源类型格式不正确',
              pattern: /^[a-z][a-z0-9_]{1,99}$/,
            }]}
          >
            <Input allowClear maxLength={100} placeholder="order" />
          </Form.Item>
          <Form.Item label="对象编号" name="resourceId" rules={[uuidRule]}>
            <Input allowClear maxLength={36} />
          </Form.Item>
          <Form.Item label="请求编号" name="requestId" rules={[{ min: 8, message: '至少输入 8 个字符' }]}>
            <Input allowClear maxLength={128} />
          </Form.Item>
          {allowTenantFilter ? (
            <Form.Item label="代理商编号" name="tenantId" rules={[uuidRule]}>
              <Input allowClear maxLength={36} />
            </Form.Item>
          ) : null}
          <Form.Item label="模糊搜索" name="q" rules={[{ min: 2, message: '至少输入 2 个字符' }]}>
            <Input allowClear maxLength={100} placeholder="操作代码、资源或请求编号" />
          </Form.Item>
        </div>
        <Space className="audit-filter-actions">
          <Button htmlType="submit" type="primary">查询</Button>
          <Button onClick={resetFilters}>重置</Button>
        </Space>
      </Form>

      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load(data.page, data.pageSize)}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}

      <Table<AuditLogRecord>
        columns={[
          {
            dataIndex: 'createdAt',
            title: '时间',
            width: 180,
            render: formatDateTime,
          },
          {
            dataIndex: 'action',
            title: '操作类型',
            render: (value: string, record) => <Typography.Text title={value}>{auditActionLabel(value, record.resource.type)}</Typography.Text>,
          },
          {
            key: 'actor',
            title: '执行人',
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Tag>{actorLabels[record.actor.type]}</Tag>
                <Typography.Text className="secondary-id" copyable={Boolean(record.actor.id)} type="secondary">
                  {record.actor.id ?? '—'}
                </Typography.Text>
              </Space>
            ),
          },
          {
            key: 'resource',
            title: '资源',
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Typography.Text title={record.resource.type}>{auditResourceLabel(record.resource.type)}</Typography.Text>
                <Typography.Text className="secondary-id" copyable={Boolean(record.resource.id)} type="secondary">
                  {record.resource.id ?? '—'}
                </Typography.Text>
              </Space>
            ),
          },
          ...(allowTenantFilter ? [{
            dataIndex: 'tenantId' as const,
            title: '代理商编号',
            width: 160,
            render: (value: string | null) => value
              ? <Typography.Text className="secondary-id" copyable>{value}</Typography.Text>
              : '平台',
          }] : []),
          {
            dataIndex: 'requestId',
            title: '请求编号',
            width: 170,
            render: (value: string) => (
              <Typography.Text className="secondary-id" copyable>{value}</Typography.Text>
            ),
          },
          {
            key: 'action-detail',
            title: '操作',
            width: 90,
            render: (_, record) => <Button size="small" onClick={() => setDetail(record)}>详情</Button>,
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无审计日志" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: (page, pageSize) => void load(page, Math.min(pageSize, 100)),
          pageSize: data.pageSize,
          pageSizeOptions: [20, 50, 100],
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: allowTenantFilter ? 1350 : 1180 }}
      />

      <AuditDetailDrawer detail={detail} onClose={() => setDetail(undefined)} />
    </>
  );
}

function AuditDetailDrawer({ detail, onClose }: {
  detail?: AuditLogRecord;
  onClose(): void;
}) {
  return (
    <Drawer onClose={onClose} open={Boolean(detail)} title="审计详情" width={820}>
      {detail ? (
        <Space direction="vertical" size={24} style={{ width: '100%' }}>
          <Descriptions bordered column={2} size="small">
            <Descriptions.Item label="时间" span={2}>{formatDateTime(detail.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="操作类型" span={2}>{auditActionLabel(detail.action, detail.resource.type)}</Descriptions.Item>
            <Descriptions.Item label="操作代码" span={2}><Typography.Text copyable>{detail.action}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="执行人类型">{actorLabels[detail.actor.type]}</Descriptions.Item>
            <Descriptions.Item label="执行人编号">{detail.actor.id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="资源类型"><Typography.Text title={detail.resource.type}>{auditResourceLabel(detail.resource.type)}</Typography.Text></Descriptions.Item>
            <Descriptions.Item label="对象编号">{detail.resource.id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="请求编号" span={2}>{detail.requestId}</Descriptions.Item>
            {detail.tenantId ? (
              <Descriptions.Item label="代理商编号" span={2}>{detail.tenantId}</Descriptions.Item>
            ) : null}
          </Descriptions>
          <JsonPanel title="变更前" value={detail.before} />
          <JsonPanel title="变更后" value={detail.after} />
        </Space>
      ) : null}
    </Drawer>
  );
}

function JsonPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <Typography.Title level={5}>{title}</Typography.Title>
      <Table size="small" rowKey="key" pagination={false}
        dataSource={snapshotRows(redactClientSide(value))}
        columns={[{ title: '字段', dataIndex: 'field', width: '40%' }, { title: '内容', dataIndex: 'value', render: text => <span style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{text}</span> }]} />
    </div>
  );
}

function buildQuery(
  filters: AuditFilterForm,
  page: number,
  pageSize: number,
  allowTenantFilter: boolean,
): URLSearchParams {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const range = filters.timeRange;
  if (range?.[0]) query.set('from', range[0].toISOString());
  if (range?.[1]) query.set('to', range[1].toISOString());
  for (const field of [
    'action',
    'actorId',
    'actorType',
    'q',
    'requestId',
    'resourceId',
    'resourceType',
  ] as const) {
    const value = filters[field];
    if (value) query.set(field, value);
  }
  if (allowTenantFilter && filters.tenantId) query.set('tenantId', filters.tenantId);
  return query;
}

function normalizeFilters(
  values: AuditFilterForm,
  allowTenantFilter: boolean,
): AuditFilterForm {
  return {
    ...values,
    action: trim(values.action),
    actorId: trim(values.actorId),
    q: trim(values.q),
    requestId: trim(values.requestId),
    resourceId: trim(values.resourceId),
    resourceType: trim(values.resourceType),
    tenantId: allowTenantFilter ? trim(values.tenantId) : undefined,
  };
}

function redactClientSide(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map((item) => redactClientSide(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 1_000)) {
    if (isSensitiveKey(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactClientSide(child, depth + 1);
    }
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized.includes('password')
    || normalized.includes('secret')
    || normalized.endsWith('key')
    || normalized.includes('accesskey')
    || normalized.includes('sessiontoken')
    || normalized.includes('apikey')
    || normalized.includes('privatekey')
    || normalized.includes('signingkey')
    || normalized.includes('encryptionkey')
    || normalized.includes('authorization')
    || normalized.includes('credential')
    || normalized.includes('cipher')
    || normalized.includes('cookie')
    || normalized.includes('token')
    || normalized.includes('hmac')
    || normalized === 'useragent';
}

function trim(value?: string): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}
