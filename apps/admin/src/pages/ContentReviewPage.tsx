import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

interface ContentReviewItem {
  contentVersionId: string;
  dramaCode: string;
  id: string;
  status: 'submitted';
  submittedAt: string;
  tenantId: string;
  tenantName: string;
  version: number;
}

interface ContentReviewListResponse {
  items: ContentReviewItem[];
  page: number;
  pageSize: number;
  total: number;
}

interface DramaTranslation {
  locale: string;
  searchKeywords?: string[] | null;
  summary?: string | null;
  title: string;
}

interface EpisodeTranslation {
  locale: string;
  title: string;
}

interface ReviewEpisode {
  durationSeconds: number;
  episodeNo: number;
  id: string;
  mediaAssetId: string;
  mediaStatus: string;
  previewSeconds: number;
  sourceUrl?: string | null;
  titles: EpisodeTranslation[];
  transcodeStatus: string;
}

interface ContentReviewDetail {
  drama: {
    code: string;
    episodes: ReviewEpisode[];
    status: string;
    translations: DramaTranslation[];
  };
  id: string;
  snapshot: unknown;
  status: string;
  submittedAt: string;
  submittedBy: string;
  tenantId: string;
  tenantName: string;
  version: number;
}

interface RejectFormValues {
  reason: string;
}

type ReviewDecision = 'approve' | 'reject';

const emptyData: ContentReviewListResponse = {
  items: [],
  page: 1,
  pageSize: 20,
  total: 0,
};

export function ContentReviewPage() {
  const { principal, request } = useAuth();
  const [rejectForm] = Form.useForm<RejectFormValues>();
  const [messageApi, messageContext] = message.useMessage();
  const [data, setData] = useState<ContentReviewListResponse>(emptyData);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<ContentReviewItem>();
  const [detail, setDetail] = useState<ContentReviewDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const detailRequestSequence = useRef(0);
  const [rejectTarget, setRejectTarget] = useState<ContentReviewItem>();
  const [action, setAction] = useState<{
    decision: ReviewDecision;
    reviewId: string;
  }>();

  const permissions = useMemo(
    () => new Set(principal?.permissions ?? []),
    [principal?.permissions],
  );
  const canApprove = permissions.has('content.review.approve');
  const canReject = permissions.has('content.review.reject');

  const load = useCallback(
    async (page = 1, pageSize = 20) => {
      setLoading(true);
      setLoadError(undefined);
      try {
        const result = await request<ContentReviewListResponse>(
          `/api/v1/platform/content/reviews?page=${page}&pageSize=${pageSize}`,
        );
        setData(result);
      } catch (reason) {
        setLoadError(errorMessage(reason, '审核列表加载失败'));
      } finally {
        setLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (reviewId: string) => {
    const sequence = ++detailRequestSequence.current;
    setDetailLoading(true);
    setDetailError(undefined);
    setDetail(undefined);
    try {
      const result = await request<ContentReviewDetail>(
        `/api/v1/platform/content/reviews/${encodeURIComponent(reviewId)}`,
      );
      if (sequence === detailRequestSequence.current) {
        setDetail(result);
      }
    } catch (reason) {
      if (sequence === detailRequestSequence.current) {
        setDetailError(errorMessage(reason, '审核详情加载失败'));
      }
    } finally {
      if (sequence === detailRequestSequence.current) {
        setDetailLoading(false);
      }
    }
  }, [request]);

  function openDetail(item: ContentReviewItem): void {
    setSelected(item);
    void loadDetail(item.id);
  }

  function closeDetail(): void {
    detailRequestSequence.current += 1;
    setSelected(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(false);
  }

  async function decide(
    item: ContentReviewItem,
    decision: ReviewDecision,
    reason?: string,
  ): Promise<void> {
    setAction({ decision, reviewId: item.id });
    try {
      await request(
        `/api/v1/platform/content/reviews/${encodeURIComponent(item.id)}/${decision}`,
        {
          body: JSON.stringify({
            reason: decision === 'reject' ? reason?.trim() : undefined,
            version: item.version,
          }),
          method: 'POST',
        },
      );
      messageApi.success(decision === 'approve' ? '内容已通过审核' : '内容已驳回');
      if (selected?.id === item.id) {
        closeDetail();
      }
      setRejectTarget(undefined);
      rejectForm.resetFields();
      const nextPage = data.items.length === 1 && data.page > 1
        ? data.page - 1
        : data.page;
      await load(nextPage, data.pageSize);
    } catch (reasonValue) {
      messageApi.error(errorMessage(reasonValue, '审核操作失败'));
    } finally {
      setAction(undefined);
    }
  }

  async function reject(values: RejectFormValues): Promise<void> {
    if (!rejectTarget) {
      return;
    }
    await decide(rejectTarget, 'reject', values.reason);
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>内容审核中心</Typography.Title>
          <Typography.Text type="secondary">
            审核商家提交的短剧内容，所有决定均使用当前版本提交。
          </Typography.Text>
        </div>
        <Button loading={loading} onClick={() => void load(data.page, data.pageSize)}>
          刷新
        </Button>
      </div>

      {loadError ? (
        <Alert
          action={(
            <Button size="small" onClick={() => void load(data.page, data.pageSize)}>
              重试
            </Button>
          )}
          className="page-alert"
          closable
          message={loadError}
          onClose={() => setLoadError(undefined)}
          showIcon
          type="error"
        />
      ) : null}

      <Table<ContentReviewItem>
        columns={[
          {
            dataIndex: 'dramaCode',
            title: '短剧',
            render: (dramaCode: string, item) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{dramaCode}</Typography.Text>
                <Typography.Text type="secondary">版本 {item.version}</Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'tenantName',
            title: '提交商家',
            render: (tenantName: string, item) => (
              <Space direction="vertical" size={0}>
                <Typography.Text>{tenantName}</Typography.Text>
                <Typography.Text className="secondary-id" type="secondary">
                  {item.tenantId}
                </Typography.Text>
              </Space>
            ),
          },
          {
            dataIndex: 'submittedAt',
            title: '提交时间',
            render: (value: string) => formatDateTime(value),
          },
          {
            dataIndex: 'status',
            title: '状态',
            render: () => <Tag color="processing">待审核</Tag>,
          },
          {
            fixed: 'right',
            key: 'actions',
            title: '操作',
            width: canApprove || canReject ? 230 : 88,
            render: (_, item) => {
              const rowLoading = action?.reviewId === item.id;
              return (
                <Space size={6} wrap>
                  <Button disabled={rowLoading} size="small" onClick={() => openDetail(item)}>
                    查看
                  </Button>
                  {canApprove ? (
                    <Popconfirm
                      cancelText="取消"
                      description="通过后内容将按发布时间上线。"
                      okButtonProps={{
                        loading: rowLoading && action?.decision === 'approve',
                      }}
                      okText="确认通过"
                      onConfirm={() => decide(item, 'approve')}
                      title="通过该内容？"
                    >
                      <Button disabled={rowLoading} size="small" type="primary">
                        通过
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {canReject ? (
                    <Button
                      danger
                      disabled={rowLoading}
                      size="small"
                      onClick={() => setRejectTarget(item)}
                    >
                      驳回
                    </Button>
                  ) : null}
                </Space>
              );
            },
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无待审核内容" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        pagination={{
          current: data.page,
          onChange: (page, pageSize) => void load(page, pageSize),
          pageSize: data.pageSize,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 980 }}
      />

      <Drawer
        destroyOnHidden
        onClose={closeDetail}
        open={Boolean(selected)}
        title="审核详情"
        width={880}
      >
        {selected ? (
          <>
            <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
              <Descriptions.Item label="短剧代码">{selected.dramaCode}</Descriptions.Item>
              <Descriptions.Item label="商家">{selected.tenantName}</Descriptions.Item>
              <Descriptions.Item label="商家 ID">
                <Typography.Text copyable>{selected.tenantId}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="审核单 ID">
                <Typography.Text copyable>{selected.id}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="内容版本 ID">
                <Typography.Text copyable>{selected.contentVersionId}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="提交时间">
                {formatDateTime(selected.submittedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="并发版本">{selected.version}</Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color="processing">待审核</Tag></Descriptions.Item>
            </Descriptions>

            {detailLoading ? (
              <Skeleton active className="review-detail-loading" paragraph={{ rows: 10 }} />
            ) : detailError ? (
              <Alert
                action={(
                  <Button size="small" onClick={() => void loadDetail(selected.id)}>
                    重试
                  </Button>
                )}
                className="review-detail-section"
                message={detailError}
                showIcon
                type="error"
              />
            ) : detail ? (
              <ReviewDetail detail={detail} />
            ) : null}
          </>
        ) : null}
      </Drawer>

      <Modal
        cancelText="取消"
        destroyOnHidden
        okButtonProps={{ danger: true }}
        okText="确认驳回"
        confirmLoading={
          action?.reviewId === rejectTarget?.id && action?.decision === 'reject'
        }
        onCancel={() => {
          if (!action) {
            setRejectTarget(undefined);
            rejectForm.resetFields();
          }
        }}
        onOk={() => rejectForm.submit()}
        open={Boolean(rejectTarget)}
        title="驳回内容"
      >
        <Typography.Paragraph type="secondary">
          请说明「{rejectTarget?.dramaCode}」未通过审核的原因，商家修改后可重新提交。
        </Typography.Paragraph>
        <Form<RejectFormValues>
          form={rejectForm}
          layout="vertical"
          onFinish={(values) => void reject(values)}
          requiredMark={false}
        >
          <Form.Item
            label="驳回原因"
            name="reason"
            rules={[
              { required: true, message: '请填写驳回原因', whitespace: true },
              { max: 2000, message: '驳回原因不能超过 2000 字' },
            ]}
          >
            <Input.TextArea
              autoFocus
              maxLength={2000}
              placeholder="请输入具体、可执行的修改建议"
              rows={5}
              showCount
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof ApiError ? reason.message : fallback;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function ReviewDetail({ detail }: { detail: ContentReviewDetail }) {
  return (
    <>
      <div className="review-detail-section">
        <Typography.Title level={5}>多语言标题与简介</Typography.Title>
        <Table<DramaTranslation>
          columns={[
            { dataIndex: 'locale', title: '语言', width: 100 },
            { dataIndex: 'title', title: '标题', width: 180 },
            {
              dataIndex: 'summary',
              title: '简介',
              render: (summary?: string | null) => summary || (
                <Typography.Text type="secondary">未填写</Typography.Text>
              ),
            },
            {
              dataIndex: 'searchKeywords',
              title: '搜索词',
              width: 180,
              render: (keywords?: string[] | null) => keywords?.length ? (
                <Space size={[4, 4]} wrap>
                  {keywords.map((keyword) => <Tag key={keyword}>{keyword}</Tag>)}
                </Space>
              ) : <Typography.Text type="secondary">—</Typography.Text>,
            },
          ]}
          dataSource={detail.drama.translations}
          locale={{ emptyText: '无多语言信息' }}
          pagination={false}
          rowKey="locale"
          scroll={{ x: 760 }}
          size="small"
        />
      </div>

      <div className="review-detail-section">
        <Space align="baseline">
          <Typography.Title level={5}>剧集与媒体状态</Typography.Title>
          <Typography.Text type="secondary">共 {detail.drama.episodes.length} 集</Typography.Text>
        </Space>
        <Table<ReviewEpisode>
          columns={[
            { dataIndex: 'episodeNo', title: '集数', width: 70 },
            {
              dataIndex: 'titles',
              title: '标题',
              render: (titles: EpisodeTranslation[]) => titles.length ? (
                <Space direction="vertical" size={0}>
                  {titles.map((title) => (
                    <Typography.Text key={title.locale}>
                      <Typography.Text type="secondary">{title.locale}</Typography.Text>
                      {' '}{title.title}
                    </Typography.Text>
                  ))}
                </Space>
              ) : <Typography.Text type="secondary">—</Typography.Text>,
            },
            {
              key: 'duration',
              title: '时长 / 试看',
              width: 120,
              render: (_, episode) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text>{formatDuration(episode.durationSeconds)}</Typography.Text>
                  <Typography.Text type="secondary">
                    试看 {formatDuration(episode.previewSeconds)}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              key: 'readiness',
              title: '媒体就绪状态',
              width: 180,
              render: (_, episode) => (
                <Space direction="vertical" size={2}>
                  <StatusTag kind="media" value={episode.mediaStatus} />
                  <StatusTag kind="transcode" value={episode.transcodeStatus} />
                </Space>
              ),
            },
            {
              dataIndex: 'sourceUrl',
              title: '媒体外链',
              width: 130,
              render: (sourceUrl?: string | null) => <SafeExternalLink value={sourceUrl} />,
            },
          ]}
          dataSource={detail.drama.episodes}
          locale={{ emptyText: '无剧集信息' }}
          pagination={false}
          rowKey="id"
          scroll={{ x: 820 }}
          size="small"
        />
      </div>

      <Collapse
        className="review-detail-section"
        items={[
          {
            children: <pre className="snapshot-json">{formatSnapshot(detail.snapshot)}</pre>,
            key: 'snapshot',
            label: '提交快照（只读）',
          },
        ]}
      />
    </>
  );
}

function StatusTag({
  kind,
  value,
}: {
  kind: 'media' | 'transcode';
  value: string;
}) {
  const ready = kind === 'media'
    ? value === 'ready'
    : value === 'ready' || value === 'not_required';
  const failed = value === 'failed' || value === 'rejected';
  return (
    <Tag color={ready ? 'green' : failed ? 'red' : 'processing'}>
      {kind === 'media' ? '媒体' : '转码'}：{value}
    </Tag>
  );
}

function SafeExternalLink({ value }: { value?: string | null }) {
  const url = safeExternalUrl(value);
  if (!value) {
    return <Typography.Text type="secondary">—</Typography.Text>;
  }
  if (!url) {
    return <Typography.Text type="danger">链接不安全</Typography.Text>;
  }
  return (
    <Typography.Link href={url.href} rel="noopener noreferrer nofollow" target="_blank">
      打开 {url.hostname}
    </Typography.Link>
  );
}

function safeExternalUrl(value?: string | null): URL | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

function formatSnapshot(snapshot: unknown): string {
  try {
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return '快照无法显示';
  }
}
