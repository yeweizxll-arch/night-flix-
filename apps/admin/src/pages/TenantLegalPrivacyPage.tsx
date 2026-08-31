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
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import {
  documentTypeLabel,
  isConflict,
  LEGAL_DOCUMENT_TYPES,
  LEGAL_LOCALES,
  localDateTimeToIso,
  type LegalDocumentType,
  type LegalLocale,
} from './legal-ui';

const LEGAL_BASE = '/api/v1/tenant/legal/documents';
const PRIVACY_BASE = '/api/v1/tenant/privacy/requests';
const PAGE_SIZE = 20;

interface LegalDocumentRecord {
  bodyMarkdown: string;
  createdAt: string;
  documentType: LegalDocumentType;
  effectiveAt?: string;
  id: string;
  locale: LegalLocale;
  publishedAt?: string;
  requiredForRegistration: boolean;
  rowVersion: number;
  status: 'draft' | 'published';
  title: string;
  updatedAt: string;
  version: number;
}

interface LegalListResponse {
  items: LegalDocumentRecord[];
  page: number;
  pageSize: number;
}

interface PrivacyRequestRecord {
  accountSubjectId: string;
  completedAt?: string;
  dataErasurePerformed: boolean;
  id: string;
  retentionSummary: Array<{ category: string; reason: string; retainedUntil: string }>;
  status: 'completed' | 'failed' | 'processing' | 'submitted';
  submittedAt: string;
  subprocessorStatus: Array<{ boundary: string; provider: string; status: string }>;
}

interface PrivacyRequestDetail extends PrivacyRequestRecord {
  retainedItems: Array<{
    category: string;
    reason: string;
    recordCount: number;
    retainedUntil: string;
  }>;
}

interface LegalFormValue {
  bodyMarkdown: string;
  documentType: LegalDocumentType;
  locale: LegalLocale;
  requiredForRegistration: boolean;
  title: string;
}

export function TenantLegalPrivacyPage() {
  const { principal, request } = useAuth();
  const [legalForm] = Form.useForm<LegalFormValue>();
  const [publishForm] = Form.useForm<{ effectiveAt: string }>();
  const [messageApi, messageContext] = message.useMessage();
  const [modalApi, modalContext] = Modal.useModal();
  const canReadLegal = principal?.permissions.includes('tenant.legal.read') ?? false;
  const canManageLegal = principal?.permissions.includes('tenant.legal.manage') ?? false;
  const canReadPrivacy = principal?.permissions.includes('tenant.privacy_request.read') ?? false;
  const [legalItems, setLegalItems] = useState<LegalDocumentRecord[]>([]);
  const [legalPage, setLegalPage] = useState(1);
  const [legalStatus, setLegalStatus] = useState<string>();
  const [legalType, setLegalType] = useState<string>();
  const [legalLocale, setLegalLocale] = useState<string>();
  const [legalLoading, setLegalLoading] = useState(false);
  const [legalError, setLegalError] = useState<string>();
  const [editing, setEditing] = useState<LegalDocumentRecord | 'create'>();
  const [publishing, setPublishing] = useState<LegalDocumentRecord>();
  const [legalSubmitting, setLegalSubmitting] = useState<string>();
  const legalSequence = useRef(0);
  const [privacyItems, setPrivacyItems] = useState<PrivacyRequestRecord[]>([]);
  const [privacyPage, setPrivacyPage] = useState(1);
  const [privacyStatus, setPrivacyStatus] = useState<string>();
  const [privacyLoading, setPrivacyLoading] = useState(false);
  const [privacyError, setPrivacyError] = useState<string>();
  const [privacyDetail, setPrivacyDetail] = useState<PrivacyRequestDetail>();
  const [privacyDetailLoading, setPrivacyDetailLoading] = useState(false);
  const privacySequence = useRef(0);

  const loadLegal = useCallback(async () => {
    if (!canReadLegal) return;
    const sequence = ++legalSequence.current;
    setLegalLoading(true);
    setLegalError(undefined);
    const query = new URLSearchParams({ page: String(legalPage), pageSize: String(PAGE_SIZE) });
    if (legalStatus) query.set('status', legalStatus);
    if (legalType) query.set('type', legalType);
    if (legalLocale) query.set('locale', legalLocale);
    try {
      const response = await request<LegalListResponse>(`${LEGAL_BASE}?${query}`);
      if (sequence === legalSequence.current) setLegalItems(response.items);
    } catch (error) {
      if (sequence === legalSequence.current) setLegalError(errorText(error, '法律文档加载失败'));
    } finally {
      if (sequence === legalSequence.current) setLegalLoading(false);
    }
  }, [canReadLegal, legalLocale, legalPage, legalStatus, legalType, request]);

  const loadPrivacy = useCallback(async () => {
    if (!canReadPrivacy) return;
    const sequence = ++privacySequence.current;
    setPrivacyLoading(true);
    setPrivacyError(undefined);
    const query = new URLSearchParams({ page: String(privacyPage), pageSize: String(PAGE_SIZE) });
    if (privacyStatus) query.set('status', privacyStatus);
    try {
      const response = await request<{ items: PrivacyRequestRecord[] }>(`${PRIVACY_BASE}?${query}`);
      if (sequence === privacySequence.current) setPrivacyItems(response.items);
    } catch (error) {
      if (sequence === privacySequence.current) setPrivacyError(errorText(error, '隐私请求加载失败'));
    } finally {
      if (sequence === privacySequence.current) setPrivacyLoading(false);
    }
  }, [canReadPrivacy, privacyPage, privacyStatus, request]);

  useEffect(() => { void loadLegal(); }, [loadLegal]);
  useEffect(() => { void loadPrivacy(); }, [loadPrivacy]);

  function openCreate(): void {
    legalForm.resetFields();
    legalForm.setFieldsValue({
      documentType: 'terms', locale: 'zh-CN', requiredForRegistration: true,
    });
    setEditing('create');
  }

  function openEdit(document: LegalDocumentRecord): void {
    legalForm.setFieldsValue({
      bodyMarkdown: document.bodyMarkdown,
      documentType: document.documentType,
      locale: document.locale,
      requiredForRegistration: document.requiredForRegistration,
      title: document.title,
    });
    setEditing(document);
  }

  function closeEditor(): void {
    legalForm.resetFields();
    setEditing(undefined);
  }

  async function saveDocument(values: LegalFormValue): Promise<void> {
    if (!editing) return;
    setLegalSubmitting('save');
    const updating = editing !== 'create';
    try {
      await request(updating ? `${LEGAL_BASE}/${editing.id}` : LEGAL_BASE, {
        body: JSON.stringify(updating ? {
          bodyMarkdown: values.bodyMarkdown,
          expectedVersion: editing.rowVersion,
          requiredForRegistration: values.requiredForRegistration,
          title: values.title.trim(),
        } : {
          bodyMarkdown: values.bodyMarkdown,
          documentType: values.documentType,
          locale: values.locale,
          requiredForRegistration: values.requiredForRegistration,
          title: values.title.trim(),
        }),
        method: updating ? 'PATCH' : 'POST',
      });
      messageApi.success(updating ? '草稿已保存' : '草稿已创建');
      closeEditor();
      await loadLegal();
    } catch (error) {
      messageApi.error(errorText(error, '草稿保存失败'));
      if (isConflict(error)) await loadLegal();
    } finally {
      setLegalSubmitting(undefined);
    }
  }

  async function publishDocument(values: { effectiveAt: string }): Promise<void> {
    if (!publishing) return;
    const effectiveAt = localDateTimeToIso(values.effectiveAt);
    if (!effectiveAt) {
      messageApi.error('请输入有效的生效时间');
      return;
    }
    setLegalSubmitting(`publish:${publishing.id}`);
    try {
      await request(`${LEGAL_BASE}/${publishing.id}/publish`, {
        body: JSON.stringify({ effectiveAt, expectedVersion: publishing.rowVersion }),
        method: 'POST',
      });
      messageApi.success('文档已发布，将按设定时间生效');
      setPublishing(undefined);
      publishForm.resetFields();
      await loadLegal();
    } catch (error) {
      messageApi.error(errorText(error, '文档发布失败'));
      if (isConflict(error)) await loadLegal();
    } finally {
      setLegalSubmitting(undefined);
    }
  }

  function removeDraft(document: LegalDocumentRecord): void {
    modalApi.confirm({
      cancelText: '取消',
      content: '只会删除当前草稿，已发布版本和用户同意记录不受影响。',
      okButtonProps: { danger: true },
      okText: '删除草稿',
      onOk: async () => {
        setLegalSubmitting(`delete:${document.id}`);
        try {
          await request(`${LEGAL_BASE}/${document.id}`, {
            body: JSON.stringify({ expectedVersion: document.rowVersion }),
            method: 'DELETE',
          });
          messageApi.success('草稿已删除');
          await loadLegal();
        } catch (error) {
          messageApi.error(errorText(error, '草稿删除失败'));
          if (isConflict(error)) await loadLegal();
        } finally {
          setLegalSubmitting(undefined);
        }
      },
      title: `删除「${document.title}」？`,
    });
  }

  async function openPrivacyDetail(record: PrivacyRequestRecord): Promise<void> {
    setPrivacyDetailLoading(true);
    try {
      setPrivacyDetail(await request<PrivacyRequestDetail>(`${PRIVACY_BASE}/${record.id}`));
    } catch (error) {
      messageApi.error(errorText(error, '隐私请求详情加载失败'));
    } finally {
      setPrivacyDetailLoading(false);
    }
  }

  const legalColumns = useMemo(() => [
    {
      key: 'document', title: '文档', render: (_: unknown, row: LegalDocumentRecord) => (
        <Space direction="vertical" size={1}>
          <Space wrap><Typography.Text strong>{row.title}</Typography.Text><Tag>{documentTypeLabel(row.documentType)}</Tag><Tag>{row.locale}</Tag></Space>
          <Typography.Text type="secondary">v{row.version} · CAS {row.rowVersion} · {row.id}</Typography.Text>
        </Space>
      ),
    },
    { key: 'required', title: '注册必选', width: 100, render: (_: unknown, row: LegalDocumentRecord) => row.requiredForRegistration ? '是' : '否' },
    { key: 'status', title: '状态', width: 150, render: (_: unknown, row: LegalDocumentRecord) => <Space direction="vertical" size={1}><Tag color={row.status === 'published' ? 'green' : 'gold'}>{row.status === 'published' ? '已发布' : '草稿'}</Tag>{row.effectiveAt ? <Typography.Text type="secondary">{new Date(row.effectiveAt).toLocaleString('zh-CN')}</Typography.Text> : null}</Space> },
    { key: 'updated', title: '更新时间', width: 180, render: (_: unknown, row: LegalDocumentRecord) => new Date(row.updatedAt).toLocaleString('zh-CN') },
    {
      fixed: 'right' as const, key: 'actions', title: '操作', width: 210,
      render: (_: unknown, row: LegalDocumentRecord) => row.status === 'draft' && canManageLegal ? (
        <Space wrap size={4}>
          <Button onClick={() => openEdit(row)} size="small">编辑</Button>
          <Button onClick={() => { publishForm.resetFields(); setPublishing(row); }} size="small" type="primary">发布</Button>
          <Button danger loading={legalSubmitting === `delete:${row.id}`} onClick={() => removeDraft(row)} size="small">删除</Button>
        </Space>
      ) : <Typography.Text type="secondary">只读</Typography.Text>,
    },
  ], [canManageLegal, legalSubmitting, publishForm]);

  const legalPanel = (
    <>
      <Space className="page-toolbar" wrap>
        <Select allowClear onChange={(value) => { setLegalPage(1); setLegalStatus(value); }} options={[{ label: '草稿', value: 'draft' }, { label: '已发布', value: 'published' }]} placeholder="状态" style={{ width: 130 }} value={legalStatus} />
        <Select allowClear onChange={(value) => { setLegalPage(1); setLegalType(value); }} options={LEGAL_DOCUMENT_TYPES.map((value) => ({ label: documentTypeLabel(value), value }))} placeholder="文档类型" style={{ width: 150 }} value={legalType} />
        <Select allowClear onChange={(value) => { setLegalPage(1); setLegalLocale(value); }} options={LEGAL_LOCALES.map((value) => ({ label: value, value }))} placeholder="语言" style={{ width: 130 }} value={legalLocale} />
        <Button loading={legalLoading} onClick={() => void loadLegal()}>刷新</Button>
        {canManageLegal ? <Button onClick={openCreate} type="primary">新建草稿</Button> : null}
      </Space>
      {legalError ? <Alert action={<Button onClick={() => void loadLegal()} size="small">重试</Button>} message={legalError} showIcon type="error" /> : null}
      <Table<LegalDocumentRecord>
        columns={legalColumns}
        dataSource={legalItems}
        expandable={{ expandedRowRender: (row) => <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{row.bodyMarkdown}</Typography.Paragraph> }}
        loading={legalLoading}
        locale={{ emptyText: <Empty description="暂无法律文档" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 960 }}
      />
      <Space className="page-pagination">
        <Button disabled={legalPage <= 1 || legalLoading} onClick={() => setLegalPage((value) => value - 1)}>上一页</Button>
        <Typography.Text>第 {legalPage} 页</Typography.Text>
        <Button disabled={legalItems.length < PAGE_SIZE || legalLoading} onClick={() => setLegalPage((value) => value + 1)}>下一页</Button>
      </Space>
    </>
  );

  const privacyPanel = (
    <>
      <Alert className="page-alert" description="本页仅查看服务端记录的处理进度、法定保留范围和第三方跟进边界，不提供手动“完成删除”按钮。" message="隐私请求只读监管" showIcon type="info" />
      <Space className="page-toolbar" wrap>
        <Select allowClear onChange={(value) => { setPrivacyPage(1); setPrivacyStatus(value); }} options={['submitted', 'processing', 'completed', 'failed'].map((value) => ({ label: value, value }))} placeholder="状态" style={{ width: 150 }} value={privacyStatus} />
        <Button loading={privacyLoading} onClick={() => void loadPrivacy()}>刷新</Button>
      </Space>
      {privacyError ? <Alert action={<Button onClick={() => void loadPrivacy()} size="small">重试</Button>} message={privacyError} showIcon type="error" /> : null}
      <Table<PrivacyRequestRecord>
        columns={[
          { dataIndex: 'id', title: '请求 ID', render: (value: string) => <Typography.Text copyable>{value}</Typography.Text> },
          { dataIndex: 'accountSubjectId', title: '账户主体', render: (value: string) => <Typography.Text copyable>{value}</Typography.Text> },
          { dataIndex: 'status', title: '状态', width: 120, render: (value: string) => <Tag>{value}</Tag> },
          { dataIndex: 'submittedAt', title: '提交时间', width: 180, render: (value: string) => new Date(value).toLocaleString('zh-CN') },
          { key: 'action', title: '操作', width: 100, render: (_: unknown, row: PrivacyRequestRecord) => <Button loading={privacyDetailLoading} onClick={() => void openPrivacyDetail(row)} size="small">详情</Button> },
        ]}
        dataSource={privacyItems}
        loading={privacyLoading}
        locale={{ emptyText: <Empty description="暂无隐私请求" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={false}
        rowKey="id"
        scroll={{ x: 900 }}
      />
      <Space className="page-pagination">
        <Button disabled={privacyPage <= 1 || privacyLoading} onClick={() => setPrivacyPage((value) => value - 1)}>上一页</Button>
        <Typography.Text>第 {privacyPage} 页</Typography.Text>
        <Button disabled={privacyItems.length < PAGE_SIZE || privacyLoading} onClick={() => setPrivacyPage((value) => value + 1)}>下一页</Button>
      </Space>
    </>
  );

  const tabs = [
    canReadLegal ? { children: legalPanel, key: 'legal', label: '法律文档' } : null,
    canReadPrivacy ? { children: privacyPanel, key: 'privacy', label: '隐私请求' } : null,
  ].filter(Boolean) as Array<{ children: ReactNode; key: string; label: string }>;

  return (
    <>
      {messageContext}{modalContext}
      <div className="page-heading"><div><Typography.Title level={2}>法律与隐私</Typography.Title><Typography.Text type="secondary">管理当前商家的法律文档版本，并只读查看用户擦除请求。</Typography.Text></div></div>
      <Tabs items={tabs} />
      <Modal cancelText="取消" destroyOnHidden confirmLoading={legalSubmitting === 'save'} okText={editing === 'create' ? '创建草稿' : '保存草稿'} onCancel={() => { if (!legalSubmitting) closeEditor(); }} onOk={() => legalForm.submit()} open={Boolean(editing)} title={editing === 'create' ? '新建法律文档草稿' : '编辑草稿'} width={760}>
        <Alert className="page-alert" message="Markdown 不允许原始 HTML；客户端也不会使用 innerHTML 渲染。" showIcon type="info" />
        <Form<LegalFormValue> form={legalForm} layout="vertical" onFinish={(values) => void saveDocument(values)} preserve={false} requiredMark={false}>
          <Space align="start" wrap>
            <Form.Item label="类型" name="documentType" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={LEGAL_DOCUMENT_TYPES.map((value) => ({ label: documentTypeLabel(value), value }))} style={{ width: 180 }} /></Form.Item>
            <Form.Item label="语言" name="locale" rules={[{ required: true }]}><Select disabled={editing !== 'create'} options={LEGAL_LOCALES.map((value) => ({ label: value, value }))} style={{ width: 150 }} /></Form.Item>
            <Form.Item name="requiredForRegistration" valuePropName="checked"><Checkbox>注册必须同意</Checkbox></Form.Item>
          </Space>
          <Form.Item label="标题" name="title" rules={[{ required: true, whitespace: true }, { max: 200 }]}><Input maxLength={200} /></Form.Item>
          <Form.Item label="Markdown 正文" name="bodyMarkdown" rules={[{ required: true, whitespace: true }, { max: 200000 }]}><Input.TextArea autoSize={{ minRows: 12, maxRows: 24 }} maxLength={200000} showCount /></Form.Item>
        </Form>
      </Modal>
      <Modal cancelText="取消" destroyOnHidden confirmLoading={Boolean(publishing && legalSubmitting === `publish:${publishing.id}`)} okButtonProps={{ danger: true }} okText="确认发布" onCancel={() => { if (!legalSubmitting) { setPublishing(undefined); publishForm.resetFields(); } }} onOk={() => publishForm.submit()} open={Boolean(publishing)} title="发布法律文档">
        <Alert className="page-alert" description="发布后该版本不可编辑或删除；已产生的用户同意将持续绑定原版本。" message="请确认生效时间" showIcon type="warning" />
        <Form form={publishForm} layout="vertical" onFinish={(values) => void publishDocument(values as { effectiveAt: string })}><Form.Item label="生效时间" name="effectiveAt" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item></Form>
      </Modal>
      <Drawer destroyOnHidden onClose={() => setPrivacyDetail(undefined)} open={Boolean(privacyDetail)} title="隐私请求详情" width={640}>
        {privacyDetail ? <Space direction="vertical" size="large" style={{ width: '100%' }}><Descriptions bordered column={1} size="small"><Descriptions.Item label="请求 ID">{privacyDetail.id}</Descriptions.Item><Descriptions.Item label="账户主体">{privacyDetail.accountSubjectId}</Descriptions.Item><Descriptions.Item label="状态">{privacyDetail.status}</Descriptions.Item><Descriptions.Item label="本地擦除已执行">{privacyDetail.dataErasurePerformed ? '是' : '否'}</Descriptions.Item><Descriptions.Item label="提交时间">{new Date(privacyDetail.submittedAt).toLocaleString('zh-CN')}</Descriptions.Item><Descriptions.Item label="完成时间">{privacyDetail.completedAt ? new Date(privacyDetail.completedAt).toLocaleString('zh-CN') : '—'}</Descriptions.Item></Descriptions><Typography.Title level={5}>法定保留项</Typography.Title>{privacyDetail.retainedItems.length ? privacyDetail.retainedItems.map((item) => <Alert key={`${item.category}:${item.reason}`} description={`${item.reason} · ${item.recordCount} 条 · 保留至 ${new Date(item.retainedUntil).toLocaleString('zh-CN')}`} message={item.category} type="info" />) : <Empty description="尚无实际保留项记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}<Typography.Title level={5}>第三方处理边界</Typography.Title>{privacyDetail.subprocessorStatus.length ? privacyDetail.subprocessorStatus.map((item) => <Alert key={`${item.provider}:${item.boundary}`} description={item.boundary} message={`${item.provider} · 需运营跟进`} type="warning" />) : <Typography.Text type="secondary">未记录需要第三方跟进的边界。</Typography.Text>}</Space> : null}
      </Drawer>
    </>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
