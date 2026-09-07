import {
  Alert,
  Button,
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
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { CustomerFeedbackPanel } from './CustomerFeedbackPanel';

type ModerationTargetType = 'bullet_comment' | 'comment' | 'report';
type InteractionAction = 'approve' | 'delete' | 'hide' | 'reject' | 'resolve' | 'restore';

interface QueueItem {
  accountId?: string;
  body?: string;
  createdAt: string;
  details?: string;
  dramaId?: string;
  episodeId?: string;
  id: string;
  parentId?: string;
  positionMs?: number;
  reasonCategory?: string;
  reporterAccountId?: string;
  sensitiveMatchCount?: number;
  status: string;
  targetId?: string;
  targetType?: 'bullet_comment' | 'comment';
  tenantId: string;
}

interface QueueResponse {
  items: QueueItem[];
  page: number;
  pageSize: number;
}

interface SensitiveWord {
  createdAt: string;
  id: string;
  scope: 'platform' | 'tenant';
  status: 'active' | 'disabled';
  tenantId?: string;
  term: string;
}

interface SensitiveWordResponse {
  items: SensitiveWord[];
  page: number;
  pageSize: number;
}

interface InteractionModerationPageProps {
  apiBase: string;
  managePermission: string;
  platformScope: boolean;
  readPermission: string;
  sensitiveWordPermission: string;
  title: string;
}

const queueEmpty: QueueResponse = { items: [], page: 1, pageSize: 20 };
const wordsEmpty: SensitiveWordResponse = { items: [], page: 1, pageSize: 20 };
const targetOptions = [
  { label: '评论', value: 'comment' },
  { label: '弹幕', value: 'bullet_comment' },
  { label: '举报', value: 'report' },
];

export function InteractionModerationPage({
  apiBase,
  managePermission,
  platformScope,
  readPermission,
  sensitiveWordPermission,
  title,
}: InteractionModerationPageProps) {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [reasonForm] = Form.useForm<{ reason: string }>();
  const [wordForm] = Form.useForm<{ term: string }>();
  const [targetType, setTargetType] = useState<ModerationTargetType>('comment');
  const [status, setStatus] = useState<string>();
  const [tenantInput, setTenantInput] = useState('');
  const [tenantFilter, setTenantFilter] = useState('');
  const [queue, setQueue] = useState(queueEmpty);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string>();
  const [selected, setSelected] = useState<QueueItem>();
  const [actionTarget, setActionTarget] = useState<{ action: InteractionAction; item: QueueItem }>();
  const [words, setWords] = useState(wordsEmpty);
  const [wordLoading, setWordLoading] = useState(false);
  const [wordError, setWordError] = useState<string>();
  const [wordModalOpen, setWordModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState<string>();
  const queueSequence = useRef(0);
  const wordSequence = useRef(0);

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes(readPermission);
  const canManage = permissions.includes(managePermission);
  const canManageWords = permissions.includes(sensitiveWordPermission);

  const loadQueue = useCallback(async (page = 1, pageSize = queue.pageSize) => {
    if (!canRead) return;
    const sequence = ++queueSequence.current;
    setQueueLoading(true);
    setQueueError(undefined);
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      targetType,
    });
    if (status) query.set('status', status);
    if (platformScope && tenantFilter) query.set('tenantId', tenantFilter);
    try {
      const result = await request<QueueResponse>(`${apiBase}/moderation?${query}`);
      if (sequence === queueSequence.current) setQueue(result);
    } catch (reason) {
      if (sequence === queueSequence.current) {
        setQueueError(errorMessage(reason, '治理队列加载失败'));
      }
    } finally {
      if (sequence === queueSequence.current) setQueueLoading(false);
    }
  }, [apiBase, canRead, platformScope, queue.pageSize, request, status, targetType, tenantFilter]);

  const loadWords = useCallback(async (page = 1, pageSize = words.pageSize) => {
    if (!canRead) return;
    const sequence = ++wordSequence.current;
    setWordLoading(true);
    setWordError(undefined);
    try {
      const result = await request<SensitiveWordResponse>(
        `${apiBase}/sensitive-words?page=${page}&pageSize=${pageSize}`,
      );
      if (sequence === wordSequence.current) setWords(result);
    } catch (reason) {
      if (sequence === wordSequence.current) {
        setWordError(errorMessage(reason, '敏感词加载失败'));
      }
    } finally {
      if (sequence === wordSequence.current) setWordLoading(false);
    }
  }, [apiBase, canRead, request, words.pageSize]);

  useEffect(() => {
    void loadQueue(1);
  }, [loadQueue]);

  useEffect(() => {
    void loadWords(1);
  }, [loadWords]);

  function applyTenantFilter(): void {
    const value = tenantInput.trim();
    if (value && !UUID_PATTERN.test(value)) {
      messageApi.error('请输入正确的代理商 UUID');
      return;
    }
    queueSequence.current += 1;
    setQueue(queueEmpty);
    setTenantFilter(value);
  }

  function openAction(item: QueueItem, action: InteractionAction): void {
    reasonForm.resetFields();
    setActionTarget({ action, item });
  }

  async function submitAction(values: { reason: string }): Promise<void> {
    if (!actionTarget) return;
    const { action, item } = actionTarget;
    const key = `${action}:${item.id}`;
    setSubmitting(key);
    try {
      await request(
        `${apiBase}/moderation/${targetType}/${encodeURIComponent(item.id)}/actions`,
        {
          body: JSON.stringify({
            action,
            reason: values.reason.trim(),
            ...(platformScope ? { tenantId: item.tenantId } : {}),
          }),
          method: 'POST',
        },
      );
      messageApi.success(`${actionLabel(action)}已完成`);
      setActionTarget(undefined);
      reasonForm.resetFields();
      setSelected(undefined);
      await loadQueue(queue.page, queue.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, `${actionLabel(action)}失败`));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function createWord(values: { term: string }): Promise<void> {
    setSubmitting('create-word');
    try {
      await request(`${apiBase}/sensitive-words`, {
        body: JSON.stringify({ term: values.term.trim() }),
        method: 'POST',
      });
      messageApi.success('敏感词已加入规则');
      setWordModalOpen(false);
      wordForm.resetFields();
      await loadWords(1, words.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '敏感词添加失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function disableWord(word: SensitiveWord): Promise<void> {
    setSubmitting(`word:${word.id}`);
    try {
      await request(`${apiBase}/sensitive-words/${encodeURIComponent(word.id)}`, {
        method: 'DELETE',
      });
      messageApi.success('敏感词已停用');
      await loadWords(words.page, words.pageSize);
    } catch (reason) {
      messageApi.error(errorMessage(reason, '敏感词停用失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  const statusOptions = targetType === 'report'
    ? [
        { label: '待处理', value: 'open' },
        { label: '处理中', value: 'reviewing' },
        { label: '已解决', value: 'resolved' },
        { label: '已驳回', value: 'rejected' },
      ]
    : [
        { label: '可见', value: 'visible' },
        { label: '待审核', value: 'pending' },
        { label: '已隐藏', value: 'hidden' },
        { label: '已删除', value: 'deleted' },
      ];

  const queueColumns = useMemo(() => [
    {
      key: 'summary',
      title: targetType === 'report' ? '举报' : '内容',
      render: (_: unknown, item: QueueItem) => (
        <Space direction="vertical" size={1}>
          <Button className="table-link-button" type="link" onClick={() => setSelected(item)}>
            {targetType === 'report'
              ? `${reasonCategoryLabel(item.reasonCategory)} · ${item.targetType === 'comment' ? '评论' : '弹幕'}`
              : compactText(item.body ?? '', 70)}
          </Button>
          <Typography.Text className="secondary-id" type="secondary">{item.id}</Typography.Text>
        </Space>
      ),
    },
    ...(platformScope ? [{
      dataIndex: 'tenantId',
      title: '代理商',
      width: 250,
      render: (value: string) => <Typography.Text copyable>{value}</Typography.Text>,
    }] : []),
    {
      key: 'target',
      title: '对象',
      render: (_: unknown, item: QueueItem) => targetType === 'report'
        ? <Typography.Text copyable>{item.targetId}</Typography.Text>
        : (
          <Space direction="vertical" size={0}>
            <Typography.Text copyable>剧：{item.dramaId}</Typography.Text>
            {item.episodeId ? <Typography.Text copyable>集：{item.episodeId}</Typography.Text> : null}
          </Space>
        ),
    },
    {
      dataIndex: 'status',
      title: '状态',
      width: 100,
      render: (value: string) => <StatusTag status={value} />,
    },
    {
      dataIndex: 'createdAt',
      title: '创建时间',
      width: 180,
      render: formatDateTime,
    },
    {
      key: 'actions',
      title: '操作',
      width: 300,
      render: (_: unknown, item: QueueItem) => canManage ? (
        <Space size={6} wrap>
          {availableActions(targetType, item.status).map((action) => (
            <Button
              danger={action === 'delete' || action === 'reject'}
              disabled={Boolean(submitting)}
              key={action}
              size="small"
              onClick={() => openAction(item, action)}
            >
              {actionLabel(action)}
            </Button>
          ))}
        </Space>
      ) : <Typography.Text type="secondary">只读</Typography.Text>,
    },
  ], [canManage, platformScope, submitting, targetType]);

  const queuePanel = (
    <>
      <div className="audit-filter-card">
        <Space wrap>
          <Select
            options={targetOptions}
            style={{ width: 130 }}
            value={targetType}
            onChange={(value) => {
              queueSequence.current += 1;
              setQueue(queueEmpty);
              setStatus(undefined);
              setTargetType(value);
            }}
          />
          <Select
            allowClear
            options={statusOptions}
            placeholder="全部状态"
            style={{ width: 130 }}
            value={status}
            onChange={(value) => {
              queueSequence.current += 1;
              setQueue(queueEmpty);
              setStatus(value);
            }}
          />
          {platformScope ? (
            <Input.Search
              allowClear
              enterButton="筛选代理商"
              placeholder="代理商 Tenant UUID"
              style={{ width: 360 }}
              value={tenantInput}
              onChange={(event) => {
                setTenantInput(event.target.value);
                if (!event.target.value) setTenantFilter('');
              }}
              onSearch={applyTenantFilter}
            />
          ) : null}
          <Button loading={queueLoading} onClick={() => void loadQueue(queue.page, queue.pageSize)}>
            刷新
          </Button>
        </Space>
      </div>
      {queueError ? (
        <Alert
          action={<Button size="small" onClick={() => void loadQueue(queue.page, queue.pageSize)}>重试</Button>}
          className="page-alert"
          message={queueError}
          showIcon
          type="error"
        />
      ) : null}
      <Table<QueueItem>
        columns={queueColumns}
        dataSource={queue.items}
        loading={queueLoading}
        locale={{ emptyText: <Empty description="当前筛选下没有治理任务" /> }}
        pagination={{
          current: queue.page,
          onChange: (page, pageSize) => void loadQueue(page, pageSize),
          pageSize: queue.pageSize,
          showSizeChanger: true,
          total: (queue.page - 1) * queue.pageSize + queue.items.length + (queue.items.length === queue.pageSize ? 1 : 0),
        }}
        rowKey="id"
        scroll={{ x: 1100 }}
      />
    </>
  );

  const wordPanel = (
    <>
      <div className="tenant-content-toolbar">
        {canManageWords ? <Button type="primary" onClick={() => setWordModalOpen(true)}>新增敏感词</Button> : null}
      </div>
      {wordError ? (
        <Alert
          action={<Button size="small" onClick={() => void loadWords(words.page, words.pageSize)}>重试</Button>}
          className="page-alert"
          message={wordError}
          showIcon
          type="error"
        />
      ) : null}
      <Table<SensitiveWord>
        dataSource={words.items}
        loading={wordLoading}
        locale={{ emptyText: <Empty description="暂无敏感词" /> }}
        pagination={{
          current: words.page,
          onChange: (page, pageSize) => void loadWords(page, pageSize),
          pageSize: words.pageSize,
          showSizeChanger: true,
          total: (words.page - 1) * words.pageSize + words.items.length + (words.items.length === words.pageSize ? 1 : 0),
        }}
        rowKey="id"
        columns={[
          { dataIndex: 'term', title: '词语', render: (term: string) => <Typography.Text>{term}</Typography.Text> },
          { dataIndex: 'scope', title: '范围', width: 100, render: (value) => value === 'platform' ? '公共' : '本代理商' },
          { dataIndex: 'status', title: '状态', width: 90, render: (value) => value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
          { dataIndex: 'createdAt', title: '创建时间', width: 180, render: formatDateTime },
          {
            key: 'action',
            title: '操作',
            width: 100,
            render: (_, word) => canManageWords && word.scope === (platformScope ? 'platform' : 'tenant') ? (word.status === 'active' ? (
              <Popconfirm title="停用该敏感词？" onConfirm={() => void disableWord(word)}>
                <Button loading={submitting === `word:${word.id}`} size="small">停用</Button>
              </Popconfirm>
            ) : <Button loading={submitting === 'create-word'} size="small" onClick={() => void createWord({ term: word.term })}>启用</Button>) : <Typography.Text type="secondary">只读</Typography.Text>,
          },
        ]}
      />
    </>
  );

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{title}</Typography.Title>
          <Typography.Text type="secondary">
            处理评论、弹幕、举报与用户反馈。
          </Typography.Text>
        </div>
      </div>
      <Tabs items={[
        { children: queuePanel, key: 'queue', label: '治理队列' },
        { children: wordPanel, key: 'words', label: '敏感词' },
        ...(!platformScope && canRead ? [{ children: <CustomerFeedbackPanel canManage={canManage} />, key: 'feedback', label: '用户反馈' }] : []),
      ]} />
      <Drawer destroyOnHidden onClose={() => setSelected(undefined)} open={Boolean(selected)} title="治理详情" width={720}>
        {selected ? <QueueDetail item={selected} targetType={targetType} /> : null}
      </Drawer>
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setActionTarget(undefined)}
        open={Boolean(actionTarget)}
        title={actionTarget ? actionLabel(actionTarget.action) : '治理操作'}
      >
        <Alert
          className="page-alert"
          message="原因必填，并会进入治理记录和审计日志。"
          showIcon
          type="warning"
        />
        <Form name="interactionmoderationpage-1" form={reasonForm} layout="vertical" onFinish={(values) => void submitAction(values)}>
          <Form.Item
            label="操作原因"
            name="reason"
            rules={[{ required: true, whitespace: true }, { max: 1000 }]}
          >
            <Input.TextArea maxLength={1000} rows={4} showCount />
          </Form.Item>
          <Button
            block
            danger={actionTarget?.action === 'delete' || actionTarget?.action === 'reject'}
            htmlType="submit"
            loading={Boolean(actionTarget && submitting === `${actionTarget.action}:${actionTarget.item.id}`)}
            type="primary"
          >
            确认{actionTarget ? actionLabel(actionTarget.action) : '操作'}
          </Button>
        </Form>
      </Modal>
      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setWordModalOpen(false)}
        open={wordModalOpen}
        title="新增敏感词"
      >
        <Form name="interactionmoderationpage-2" form={wordForm} layout="vertical" onFinish={(values) => void createWord(values)}>
          <Form.Item label="词语" name="term" rules={[{ min: 2, max: 64, required: true, whitespace: true }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Button block htmlType="submit" loading={submitting === 'create-word'} type="primary">新增</Button>
        </Form>
      </Modal>
    </>
  );
}

function QueueDetail({ item, targetType }: { item: QueueItem; targetType: ModerationTargetType }) {
  const entries = targetType === 'report'
    ? [
        ['举报类别', reasonCategoryLabel(item.reasonCategory)],
        ['举报说明', item.details ?? '—'],
        ['被举报类型', item.targetType === 'comment' ? '评论' : '弹幕'],
        ['被举报 ID', item.targetId ?? '—'],
        ['举报人账号', item.reporterAccountId ?? '—'],
      ]
    : [
        ['正文', item.body ?? '—'],
        ['短剧 ID', item.dramaId ?? '—'],
        ['剧集 ID', item.episodeId ?? '—'],
        ['账号 ID', item.accountId ?? '—'],
        ['父评论 ID', item.parentId ?? '—'],
        ['命中敏感词数量', String(item.sensitiveMatchCount ?? 0)],
        ['弹幕位置', item.positionMs === undefined ? '—' : `${item.positionMs} ms`],
      ];
  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="记录 ID"><Typography.Text copyable>{item.id}</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="代理商 ID"><Typography.Text copyable>{item.tenantId}</Typography.Text></Descriptions.Item>
      <Descriptions.Item label="状态"><StatusTag status={item.status} /></Descriptions.Item>
      {entries.map(([label, value]) => (
        <Descriptions.Item key={label} label={label}>
          <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {value}
          </Typography.Paragraph>
        </Descriptions.Item>
      ))}
      <Descriptions.Item label="创建时间">{formatDateTime(item.createdAt)}</Descriptions.Item>
    </Descriptions>
  );
}

function availableActions(targetType: ModerationTargetType, status: string): InteractionAction[] {
  if (targetType === 'report') return ['open', 'reviewing'].includes(status) ? ['resolve', 'reject'] : [];
  if (status === 'deleted') return ['restore'];
  if (status === 'visible') return ['hide', 'delete'];
  if (status === 'hidden') return ['approve', 'delete'];
  return ['approve', 'hide', 'delete'];
}

function actionLabel(action: InteractionAction): string {
  return ({
    approve: '通过',
    delete: '删除',
    hide: '隐藏',
    reject: '驳回举报',
    resolve: '解决举报',
    restore: '恢复',
  } as const)[action];
}

function reasonCategoryLabel(value?: string): string {
  return ({
    abuse: '辱骂',
    copyright: '版权',
    harassment: '骚扰',
    illegal: '违法',
    other: '其他',
    spam: '垃圾信息',
  } as Record<string, string>)[value ?? ''] ?? value ?? '未分类';
}

function StatusTag({ status }: { status: string }) {
  const labels: Record<string, { color?: string; text: string }> = {
    deleted: { color: 'red', text: '已删除' },
    hidden: { color: 'orange', text: '已隐藏' },
    open: { color: 'orange', text: '待处理' },
    pending: { color: 'blue', text: '待审核' },
    rejected: { text: '已驳回' },
    resolved: { color: 'green', text: '已解决' },
    reviewing: { color: 'blue', text: '处理中' },
    visible: { color: 'green', text: '可见' },
  };
  const option = labels[status] ?? { text: status };
  return <Tag color={option.color}>{option.text}</Tag>;
}

function compactText(value: string, maximum: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text || '（空）';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError) {
    return reason.status === 409 ? `${reason.message}，请刷新后重试` : reason.message;
  }
  return fallback;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
