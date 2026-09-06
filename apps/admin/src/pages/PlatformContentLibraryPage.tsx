import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { BatchEpisodeUploadModal } from './BatchEpisodeUploadModal';
import { uploadEpisodeFile } from './batch-episodes';
import { readVideoDuration } from './video-duration';
import {
  contentFileExtension,
  contentUploadHeaders,
  formatContentBytes,
  validateContentUploadFile,
  validateContentUploadIntent,
} from './content-upload-ui';
import {
  canUploadEpisodeMedia,
  episodeConflictRefreshPlan,
  episodeMediaValues,
  isContentVersionConflict,
  previewMediaPatch,
} from './episode-media-ui';
import {
  assertUniqueLocales,
  contentLocaleOptions,
  type ContentLocale,
  type DramaStatus,
  isDramaEditable,
  isDramaPublishable,
  isDramaRestorable,
  isDramaUnpublishable,
  isUuid,
  keywordList,
  optionalCanonicalIso,
} from './platform-content-library-ui';
import { sha256Blob } from './file-sha256';

const API_BASE = '/api/v1/platform/content-management';

interface DramaTranslation {
  locale: ContentLocale;
  searchKeywords?: string[];
  summary?: string;
  title: string;
}

interface EpisodeTranslation { locale: ContentLocale; title: string }

interface EpisodeTrackRecord {
  id: string;
  isDefault: boolean;
  label: string;
  locale: string;
  mediaAssetId: string;
  status: 'active' | 'disabled';
  type: 'dubbing' | 'subtitle';
}

interface EpisodeRecord {
  dramaId: string;
  durationSeconds: number;
  episodeNo: number;
  id: string;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
  releaseAt?: string;
  status: 'approved' | 'draft' | 'published' | 'unpublished';
  tracks: EpisodeTrackRecord[];
  translations: EpisodeTranslation[];
  unpublishAt?: string;
  version: number;
}

interface DramaRecord {
  categoryId?: string;
  code: string;
  coverMediaAssetId?: string;
  createdAt: string;
  deletedAt?: string;
  episodes?: EpisodeRecord[];
  id: string;
  releaseAt?: string;
  publicReleaseLockedAt?: string;
  publicRevision?: number;
  restoreUntil?: string;
  shanchuangCreatorId?: string;
  shanchuangWorkId?: string;
  status: DramaStatus;
  supersedesDramaId?: string;
  tagIds: string[];
  totalEpisodes: number;
  translations: DramaTranslation[];
  unpublishAt?: string;
  version: number;
}

interface TaxonomyTranslation { locale: ContentLocale; name: string }

interface TaxonomyRecord {
  code: string;
  deletedAt?: string;
  id: string;
  restoreUntil?: string;
  sortOrder?: number;
  status: 'active' | 'disabled';
  translations: TaxonomyTranslation[];
  version: number;
}

interface PageResponse<T> { items: T[]; page: number; pageSize: number; total: number }

interface DramaTranslationForm extends Omit<DramaTranslation, 'searchKeywords'> {
  searchKeywords?: string;
}

interface DramaFormValue {
  categoryId?: string;
  code: string;
  coverMediaAssetId?: string;
  publicRevision?: number;
  releaseAt?: string;
  shanchuangCreatorId?: string;
  shanchuangWorkId?: string;
  supersedesDramaId?: string;
  tagIds?: string[];
  translations: DramaTranslationForm[];
  unpublishAt?: string;
}

interface EpisodeFormValue {
  durationSeconds: number;
  episodeNo: number;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds?: number;
  releaseAt?: string;
  translations: EpisodeTranslation[];
  unpublishAt?: string;
}

interface EpisodeTrackFormValue {
  isDefault?: boolean;
  label: string;
  locale: string;
  mediaAssetId: string;
  type: 'dubbing' | 'subtitle';
}

interface TaxonomyFormValue {
  code: string;
  sortOrder?: number;
  status: 'active' | 'disabled';
  translations: TaxonomyTranslation[];
}

interface DeleteFormValue { confirmed: boolean; reason: string }
type TaxonomyType = 'categories' | 'tags';
type TaxonomyEditor = { record?: TaxonomyRecord; type: TaxonomyType };
type DeleteTarget =
  | { kind: 'drama'; record: DramaRecord }
  | { kind: TaxonomyType; record: TaxonomyRecord };
type UploadTarget = 'cover' | 'episode-main' | 'episode-preview' | 'track';

const emptyDramas: PageResponse<DramaRecord> = { items: [], page: 1, pageSize: 20, total: 0 };
const emptyTaxonomy: PageResponse<TaxonomyRecord> = { items: [], page: 1, pageSize: 20, total: 0 };

export function PlatformContentLibraryPage() {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [dramaForm] = Form.useForm<DramaFormValue>();
  const [episodeForm] = Form.useForm<EpisodeFormValue>();
  const [episodeTrackForm] = Form.useForm<EpisodeTrackFormValue>();
  const [taxonomyForm] = Form.useForm<TaxonomyFormValue>();
  const [deleteForm] = Form.useForm<DeleteFormValue>();
  const [dramas, setDramas] = useState(emptyDramas);
  const [categories, setCategories] = useState(emptyTaxonomy);
  const [tags, setTags] = useState(emptyTaxonomy);
  const [categoryOptions, setCategoryOptions] = useState<TaxonomyRecord[]>([]);
  const [tagOptions, setTagOptions] = useState<TaxonomyRecord[]>([]);
  const [dramaStatus, setDramaStatus] = useState<DramaStatus>();
  const [includeDeletedDramas, setIncludeDeletedDramas] = useState(false);
  const [includeDeletedCategories, setIncludeDeletedCategories] = useState(false);
  const [includeDeletedTags, setIncludeDeletedTags] = useState(false);
  const [dramaLoading, setDramaLoading] = useState(true);
  const [taxonomyLoading, setTaxonomyLoading] = useState<Record<TaxonomyType, boolean>>({ categories: true, tags: true });
  const [dramaError, setDramaError] = useState<string>();
  const [taxonomyError, setTaxonomyError] = useState<Partial<Record<TaxonomyType, string>>>({});
  const [selected, setSelected] = useState<DramaRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [dramaEditor, setDramaEditor] = useState<'create' | DramaRecord>();
  const [revisionSource, setRevisionSource] = useState<DramaRecord>();
  const [episodeEditor, setEpisodeEditor] = useState<{ drama: DramaRecord; episode?: EpisodeRecord }>();
  const [episodeTrackEditor, setEpisodeTrackEditor] = useState<{ drama: DramaRecord; episode: EpisodeRecord }>();
  const [taxonomyEditor, setTaxonomyEditor] = useState<TaxonomyEditor>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [uploadTarget, setUploadTarget] = useState<UploadTarget>();
  const [batchDrama, setBatchDrama] = useState<DramaRecord>();
  const [submitting, setSubmitting] = useState<string>();
  const dramaSequence = useRef(0);
  const detailSequence = useRef(0);
  const taxonomySequence = useRef<Record<TaxonomyType, number>>({ categories: 0, tags: 0 });
  const dramaPageSize = useRef(20);
  const taxonomyPageSize = useRef<Record<TaxonomyType, number>>({ categories: 20, tags: 20 });

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes('platform.content.read');
  const canManage = permissions.includes('platform.content.manage');
  const canPublish = permissions.includes('platform.content.publish');
  const canUploadEpisode = canUploadEpisodeMedia('platform', permissions);

  const loadDramas = useCallback(async (page = 1, pageSize = dramaPageSize.current) => {
    if (!canRead) return;
    const sequence = ++dramaSequence.current;
    dramaPageSize.current = pageSize;
    setDramaLoading(true);
    setDramaError(undefined);
    const query = new URLSearchParams({
      deleted: String(includeDeletedDramas), page: String(page), pageSize: String(pageSize),
    });
    if (dramaStatus) query.set('status', dramaStatus);
    try {
      const result = await request<PageResponse<DramaRecord>>(`${API_BASE}/dramas?${query}`);
      if (sequence === dramaSequence.current) setDramas(result);
    } catch (reason) {
      if (sequence === dramaSequence.current) setDramaError(contentError(reason, '公共短剧列表加载失败'));
    } finally {
      if (sequence === dramaSequence.current) setDramaLoading(false);
    }
  }, [canRead, dramaStatus, includeDeletedDramas, request]);

  const loadTaxonomy = useCallback(async (
    type: TaxonomyType,
    page = 1,
    pageSize = taxonomyPageSize.current[type],
  ) => {
    if (!canRead) return;
    const sequence = ++taxonomySequence.current[type];
    taxonomyPageSize.current[type] = pageSize;
    setTaxonomyLoading((current) => ({ ...current, [type]: true }));
    setTaxonomyError((current) => ({ ...current, [type]: undefined }));
    const deleted = type === 'categories' ? includeDeletedCategories : includeDeletedTags;
    try {
      const result = await request<PageResponse<TaxonomyRecord>>(
        `${API_BASE}/${type}?page=${page}&pageSize=${pageSize}&deleted=${deleted}`,
      );
      if (sequence !== taxonomySequence.current[type]) return;
      if (type === 'categories') setCategories(result);
      else setTags(result);
    } catch (reason) {
      if (sequence === taxonomySequence.current[type]) {
        setTaxonomyError((current) => ({
          ...current, [type]: contentError(reason, `${taxonomyName(type)}列表加载失败`),
        }));
      }
    } finally {
      if (sequence === taxonomySequence.current[type]) {
        setTaxonomyLoading((current) => ({ ...current, [type]: false }));
      }
    }
  }, [canRead, includeDeletedCategories, includeDeletedTags, request]);

  const loadTaxonomyOptions = useCallback(async () => {
    if (!canRead) return;
    try {
      const [categoryResult, tagResult] = await Promise.all([
        request<PageResponse<TaxonomyRecord>>(`${API_BASE}/categories?page=1&pageSize=100&deleted=false`),
        request<PageResponse<TaxonomyRecord>>(`${API_BASE}/tags?page=1&pageSize=100&deleted=false`),
      ]);
      setCategoryOptions(categoryResult.items.filter((item) => item.status === 'active'));
      setTagOptions(tagResult.items.filter((item) => item.status === 'active'));
    } catch {
      // Management lists surface the error and UUIDs already attached to a drama remain visible.
    }
  }, [canRead, request]);

  useEffect(() => { void loadDramas(1); }, [loadDramas]);
  useEffect(() => { void loadTaxonomy('categories', 1); }, [loadTaxonomy]);
  useEffect(() => { void loadTaxonomy('tags', 1); }, [loadTaxonomy]);
  useEffect(() => { void loadTaxonomyOptions(); }, [loadTaxonomyOptions]);

  async function openDetail(record: DramaRecord): Promise<void> {
    const sequence = ++detailSequence.current;
    setSelected(record);
    setDetailLoading(true);
    setDetailError(undefined);
    try {
      const detail = await request<DramaRecord>(`${API_BASE}/dramas/${encodeURIComponent(record.id)}`);
      if (sequence === detailSequence.current) setSelected(detail);
    } catch (reason) {
      if (sequence === detailSequence.current) setDetailError(contentError(reason, '短剧详情加载失败'));
    } finally {
      if (sequence === detailSequence.current) setDetailLoading(false);
    }
  }

  function closeDetail(): void {
    detailSequence.current += 1;
    setSelected(undefined);
    setDetailError(undefined);
    setEpisodeEditor(undefined);
    setEpisodeTrackEditor(undefined);
    episodeForm.resetFields();
    episodeTrackForm.resetFields();
  }

  function openDramaEditor(record?: DramaRecord): void {
    setRevisionSource(undefined);
    dramaForm.resetFields();
    dramaForm.setFieldsValue(record ? {
      categoryId: record.categoryId,
      code: record.code,
      coverMediaAssetId: record.coverMediaAssetId,
      releaseAt: record.releaseAt,
      tagIds: record.tagIds,
      translations: record.translations.map((translation) => ({
        ...translation, searchKeywords: translation.searchKeywords?.join(', '),
      })),
      unpublishAt: record.unpublishAt,
    } : {
      tagIds: [],
      translations: [{ locale: 'zh-CN', searchKeywords: '', summary: '', title: '' }],
    });
    setDramaEditor(record ?? 'create');
  }

  function openRevisionEditor(record: DramaRecord): void {
    if (!record.shanchuangWorkId || !record.shanchuangCreatorId || !record.publicRevision) {
      messageApi.error('该公共剧缺少闪创来源标识，不能创建连续版本');
      return;
    }
    setRevisionSource(record);
    dramaForm.resetFields();
    dramaForm.setFieldsValue({
      categoryId: record.categoryId,
      code: `${record.code}-r${record.publicRevision + 1}`.slice(0, 128),
      coverMediaAssetId: record.coverMediaAssetId,
      publicRevision: record.publicRevision + 1,
      shanchuangCreatorId: record.shanchuangCreatorId,
      shanchuangWorkId: record.shanchuangWorkId,
      supersedesDramaId: record.id,
      tagIds: record.tagIds,
      translations: record.translations.map((translation) => ({
        ...translation, searchKeywords: translation.searchKeywords?.join(', '),
      })),
    });
    setDramaEditor('create');
  }

  function closeDramaEditor(): void {
    setDramaEditor(undefined);
    setRevisionSource(undefined);
    dramaForm.resetFields();
  }

  async function saveDrama(values: DramaFormValue): Promise<void> {
    if (!dramaEditor) return;
    let releaseAt: string | undefined;
    let unpublishAt: string | undefined;
    let translations: DramaTranslation[];
    try {
      releaseAt = optionalCanonicalIso(values.releaseAt);
      unpublishAt = optionalCanonicalIso(values.unpublishAt);
      assertSchedule(releaseAt, unpublishAt);
      assertUniqueLocales(values.translations);
      translations = values.translations.map((translation) => ({
        locale: translation.locale,
        searchKeywords: keywordList(translation.searchKeywords),
        summary: translation.summary?.trim() ?? '',
        title: translation.title.trim(),
      }));
      if (values.coverMediaAssetId?.trim() && !isUuid(values.coverMediaAssetId.trim())) {
        throw new Error('封面 Media Asset ID 必须是 UUID');
      }
    } catch (reason) {
      messageApi.error(localError(reason));
      return;
    }
    const target = dramaEditor === 'create' ? undefined : dramaEditor;
    const normalizedCode = values.code.trim().toLowerCase();
    let payload: Record<string, unknown>;
    if (target) {
      payload = { expectedVersion: target.version };
      const categoryId = values.categoryId || null;
      const coverMediaAssetId = values.coverMediaAssetId?.trim() || null;
      if (normalizedCode !== target.code) payload.code = normalizedCode;
      if (categoryId !== (target.categoryId ?? null)) payload.categoryId = categoryId;
      if (coverMediaAssetId !== (target.coverMediaAssetId ?? null)) {
        payload.coverMediaAssetId = coverMediaAssetId;
      }
      if ((releaseAt ?? null) !== (target.releaseAt ?? null)) payload.releaseAt = releaseAt ?? null;
      if ((unpublishAt ?? null) !== (target.unpublishAt ?? null)) payload.unpublishAt = unpublishAt ?? null;
      if (!sameStringSet(values.tagIds ?? [], target.tagIds)) payload.tagIds = values.tagIds ?? [];
      if (JSON.stringify(normalizeDramaTranslations(translations))
        !== JSON.stringify(normalizeDramaTranslations(target.translations))) {
        payload.translations = translations;
      }
      if (Object.keys(payload).length === 1) {
        messageApi.info('没有需要保存的短剧变更');
        return;
      }
    } else payload = {
      categoryId: values.categoryId || undefined,
      code: normalizedCode,
      coverMediaAssetId: values.coverMediaAssetId?.trim() || undefined,
      publicRevision: values.publicRevision,
      releaseAt,
      shanchuangCreatorId: values.shanchuangCreatorId?.trim() || undefined,
      shanchuangWorkId: values.shanchuangWorkId?.trim() || undefined,
      supersedesDramaId: values.supersedesDramaId?.trim() || undefined,
      tagIds: values.tagIds ?? [],
      translations,
      unpublishAt,
    };
    setSubmitting(target ? `drama:${target.id}` : 'drama:create');
    try {
      const result = await request<DramaRecord>(
        target ? `${API_BASE}/dramas/${encodeURIComponent(target.id)}` : `${API_BASE}/dramas`,
        { body: JSON.stringify(payload), method: target ? 'PATCH' : 'POST' },
      );
      messageApi.success(target ? '公共短剧已更新' : '公共短剧已创建');
      closeDramaEditor();
      await loadDramas(target ? dramas.page : 1, dramas.pageSize);
      if (selected?.id === result.id) await openDetail(result);
    } catch (reason) {
      messageApi.error(contentError(reason, target ? '短剧更新失败' : '短剧创建失败'));
      if (isConflict(reason)) {
        closeDramaEditor();
        await loadDramas(dramas.page, dramas.pageSize);
        if (target && selected?.id === target.id) await openDetail(target);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function openEpisodeEditor(drama: DramaRecord, episode?: EpisodeRecord): void {
    episodeForm.resetFields();
    episodeForm.setFieldsValue(episode ? {
      durationSeconds: episode.durationSeconds,
      episodeNo: episode.episodeNo,
      mediaAssetId: episode.mediaAssetId,
      previewMediaAssetId: episode.previewMediaAssetId,
      previewSeconds: episode.previewSeconds,
      releaseAt: episode.releaseAt,
      translations: episode.translations,
      unpublishAt: episode.unpublishAt,
    } : {
      episodeNo: Math.max(1, drama.totalEpisodes + 1),
      previewSeconds: 0,
      translations: [{ locale: 'zh-CN', title: '' }],
    });
    setEpisodeEditor({ drama, episode });
  }

  function closeEpisodeEditor(): void {
    setEpisodeEditor(undefined);
    episodeForm.resetFields();
  }

  function openEpisodeTrackEditor(drama: DramaRecord, episode: EpisodeRecord): void {
    episodeTrackForm.resetFields();
    episodeTrackForm.setFieldsValue({ isDefault: false, locale: 'en', type: 'subtitle' });
    setEpisodeTrackEditor({ drama, episode });
  }

  function closeEpisodeTrackEditor(): void {
    setEpisodeTrackEditor(undefined);
    episodeTrackForm.resetFields();
  }

  async function saveEpisodeTrack(values: EpisodeTrackFormValue): Promise<void> {
    if (!episodeTrackEditor) return;
    const { drama, episode } = episodeTrackEditor;
    if (!isUuid(values.mediaAssetId.trim())) {
      messageApi.error('字幕或配音 Media Asset ID 必须是 UUID');
      return;
    }
    setSubmitting(`track:create:${episode.id}`);
    try {
      await request(`${API_BASE}/dramas/${encodeURIComponent(drama.id)}/episodes/${encodeURIComponent(episode.id)}/tracks`, {
        body: JSON.stringify({
          expectedDramaVersion: selected?.id === drama.id ? selected.version : drama.version,
          isDefault: Boolean(values.isDefault),
          label: values.label.trim(),
          locale: values.locale.trim(),
          mediaAssetId: values.mediaAssetId.trim(),
          type: values.type,
        }),
        method: 'POST',
      });
      messageApi.success('字幕或配音轨道已保存');
      episodeTrackForm.resetFields();
      await loadDramas(dramas.page, dramas.pageSize);
      await openDetail(drama);
      closeEpisodeTrackEditor();
    } catch (reason) {
      messageApi.error(contentError(reason, '轨道保存失败'));
      if (isConflict(reason)) {
        await loadDramas(dramas.page, dramas.pageSize);
        await openDetail(drama);
        closeEpisodeTrackEditor();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function disableEpisodeTrack(track: EpisodeTrackRecord): Promise<void> {
    if (!episodeTrackEditor) return;
    const { drama, episode } = episodeTrackEditor;
    setSubmitting(`track:disable:${track.id}`);
    try {
      await request(`${API_BASE}/dramas/${encodeURIComponent(drama.id)}/episodes/${encodeURIComponent(episode.id)}/tracks/${encodeURIComponent(track.id)}`, {
        body: JSON.stringify({ expectedVersion: selected?.id === drama.id ? selected.version : drama.version }),
        method: 'DELETE',
      });
      messageApi.success('轨道已停用');
      await loadDramas(dramas.page, dramas.pageSize);
      await openDetail(drama);
      closeEpisodeTrackEditor();
    } catch (reason) {
      messageApi.error(contentError(reason, '轨道停用失败'));
      if (isConflict(reason)) {
        await openDetail(drama);
        closeEpisodeTrackEditor();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function saveEpisode(values: EpisodeFormValue): Promise<void> {
    if (!episodeEditor) return;
    let releaseAt: string | undefined;
    let unpublishAt: string | undefined;
    let media: ReturnType<typeof episodeMediaValues>;
    try {
      media = episodeMediaValues(values.mediaAssetId, values.previewMediaAssetId, isUuid);
      releaseAt = optionalCanonicalIso(values.releaseAt);
      unpublishAt = optionalCanonicalIso(values.unpublishAt);
      assertSchedule(releaseAt, unpublishAt);
      assertUniqueLocales(values.translations);
      if ((values.previewSeconds ?? 0) > values.durationSeconds) {
        throw new Error('试看秒数不能超过视频时长');
      }
    } catch (reason) {
      messageApi.error(localError(reason));
      return;
    }
    const { drama, episode } = episodeEditor;
    const translations = values.translations.map((item) => ({ ...item, title: item.title.trim() }));
    let payload: Record<string, unknown>;
    if (episode) {
      payload = { expectedVersion: episode.version };
      if (values.durationSeconds !== episode.durationSeconds) payload.durationSeconds = values.durationSeconds;
      if (values.episodeNo !== episode.episodeNo) payload.episodeNo = values.episodeNo;
      if (media.mediaAssetId !== episode.mediaAssetId) payload.mediaAssetId = media.mediaAssetId;
      const previewPatch = previewMediaPatch(episode.previewMediaAssetId, media.previewMediaAssetId);
      if (previewPatch.changed) payload.previewMediaAssetId = previewPatch.value;
      if ((values.previewSeconds ?? 0) !== episode.previewSeconds) payload.previewSeconds = values.previewSeconds ?? 0;
      if ((releaseAt ?? null) !== (episode.releaseAt ?? null)) payload.releaseAt = releaseAt ?? null;
      if ((unpublishAt ?? null) !== (episode.unpublishAt ?? null)) payload.unpublishAt = unpublishAt ?? null;
      if (JSON.stringify(translations) !== JSON.stringify(episode.translations)) {
        payload.translations = translations;
      }
      if (Object.keys(payload).length === 1) {
        messageApi.info('没有需要保存的剧集变更');
        return;
      }
    } else payload = {
      durationSeconds: values.durationSeconds,
      episodeNo: values.episodeNo,
      expectedDramaVersion: drama.version,
      mediaAssetId: media.mediaAssetId,
      ...(media.previewMediaAssetId ? { previewMediaAssetId: media.previewMediaAssetId } : {}),
      previewSeconds: values.previewSeconds ?? 0,
      releaseAt,
      translations,
      unpublishAt,
    };
    setSubmitting(episode ? `episode:${episode.id}` : `episode:create:${drama.id}`);
    try {
      const base = `${API_BASE}/dramas/${encodeURIComponent(drama.id)}/episodes`;
      await request(episode ? `${base}/${encodeURIComponent(episode.id)}` : base, {
        body: JSON.stringify(payload), method: episode ? 'PATCH' : 'POST',
      });
      messageApi.success(episode ? '剧集已更新' : '剧集已添加');
      closeEpisodeEditor();
      await loadDramas(dramas.page, dramas.pageSize);
      await openDetail(drama);
    } catch (reason) {
      messageApi.error(contentError(reason, episode ? '剧集更新失败' : '剧集添加失败'));
      if (episodeConflictRefreshPlan(reason)) {
        closeEpisodeEditor();
        await loadDramas(dramas.page, dramas.pageSize);
        await openDetail(drama);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function dramaAction(record: DramaRecord, action: 'publish' | 'restore' | 'unpublish') {
    setSubmitting(`${action}:${record.id}`);
    try {
      const result = await request<DramaRecord & { publication?: 'published' | 'scheduled' }>(
        `${API_BASE}/dramas/${encodeURIComponent(record.id)}/${action}`,
        { body: JSON.stringify({ expectedVersion: record.version }), method: 'POST' },
      );
      messageApi.success(action === 'publish'
        ? result.publication === 'scheduled' ? '已建立定时发布计划' : '公共短剧已发布'
        : action === 'unpublish' ? '公共短剧已下架' : '公共短剧已恢复');
      await loadDramas(dramas.page, dramas.pageSize);
      if (selected?.id === record.id) await openDetail(result);
    } catch (reason) {
      messageApi.error(contentError(reason, '内容状态操作失败'));
      if (isConflict(reason)) {
        await loadDramas(dramas.page, dramas.pageSize);
        if (selected?.id === record.id) await openDetail(record);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function openTaxonomyEditor(type: TaxonomyType, record?: TaxonomyRecord): void {
    taxonomyForm.resetFields();
    taxonomyForm.setFieldsValue(record ? {
      code: record.code,
      sortOrder: record.sortOrder,
      status: record.status,
      translations: record.translations,
    } : {
      sortOrder: 0,
      status: 'active',
      translations: [{ locale: 'zh-CN', name: '' }],
    });
    setTaxonomyEditor({ record, type });
  }

  function closeTaxonomyEditor(): void {
    setTaxonomyEditor(undefined);
    taxonomyForm.resetFields();
  }

  async function saveTaxonomy(values: TaxonomyFormValue): Promise<void> {
    if (!taxonomyEditor) return;
    try { assertUniqueLocales(values.translations); }
    catch (reason) { messageApi.error(localError(reason)); return; }
    const { record, type } = taxonomyEditor;
    const payload = {
      code: values.code.trim().toLowerCase(),
      ...(type === 'categories' ? { sortOrder: values.sortOrder ?? 0 } : {}),
      status: values.status,
      translations: values.translations.map((translation) => ({
        ...translation, name: translation.name.trim(),
      })),
      ...(record ? { expectedVersion: record.version } : {}),
    };
    setSubmitting(record ? `${type}:${record.id}` : `${type}:create`);
    try {
      await request(
        record ? `${API_BASE}/${type}/${encodeURIComponent(record.id)}` : `${API_BASE}/${type}`,
        { body: JSON.stringify(payload), method: record ? 'PATCH' : 'POST' },
      );
      messageApi.success(`${taxonomyName(type)}已${record ? '更新' : '创建'}`);
      closeTaxonomyEditor();
      const current = type === 'categories' ? categories : tags;
      await Promise.all([
        loadTaxonomy(type, record ? current.page : 1, current.pageSize),
        loadTaxonomyOptions(),
      ]);
    } catch (reason) {
      messageApi.error(contentError(reason, `${taxonomyName(type)}保存失败`));
      if (isConflict(reason)) {
        closeTaxonomyEditor();
        const current = type === 'categories' ? categories : tags;
        await loadTaxonomy(type, current.page, current.pageSize);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function openDelete(target: DeleteTarget): void {
    deleteForm.resetFields();
    deleteForm.setFieldsValue({ confirmed: false });
    setDeleteTarget(target);
  }

  function closeDelete(): void {
    setDeleteTarget(undefined);
    deleteForm.resetFields();
  }

  async function deleteContent(values: DeleteFormValue): Promise<void> {
    if (!deleteTarget) return;
    const { kind, record } = deleteTarget;
    const path = kind === 'drama'
      ? `${API_BASE}/dramas/${encodeURIComponent(record.id)}`
      : `${API_BASE}/${kind}/${encodeURIComponent(record.id)}`;
    setSubmitting(`delete:${kind}:${record.id}`);
    try {
      await request<{ deletedAt: string; restoreUntil: string; version: number }>(path, {
        body: JSON.stringify({ expectedVersion: record.version, reason: values.reason.trim() }),
        method: 'DELETE',
      });
      messageApi.success(kind === 'drama'
        ? '公共短剧已软删除，可在 30 天恢复期内恢复'
        : `${taxonomyName(kind)}已软删除，可在 30 天恢复期内恢复`);
      closeDelete();
      if (kind === 'drama') {
        closeDetail();
        await loadDramas(dramas.page, dramas.pageSize);
      } else {
        const current = kind === 'categories' ? categories : tags;
        await Promise.all([
          loadTaxonomy(kind, current.page, current.pageSize), loadTaxonomyOptions(),
        ]);
      }
    } catch (reason) {
      messageApi.error(contentError(reason, '软删除失败'));
      if (isConflict(reason)) {
        closeDelete();
        if (kind === 'drama') await loadDramas(dramas.page, dramas.pageSize);
        else {
          const current = kind === 'categories' ? categories : tags;
          await loadTaxonomy(kind, current.page, current.pageSize);
        }
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function restoreTaxonomy(type: TaxonomyType, record: TaxonomyRecord): Promise<void> {
    setSubmitting(`restore:${type}:${record.id}`);
    try {
      await request(`${API_BASE}/${type}/${encodeURIComponent(record.id)}/restore`, {
        body: JSON.stringify({ expectedVersion: record.version }),
        method: 'POST',
      });
      messageApi.success(`${taxonomyName(type)}已恢复`);
      const current = type === 'categories' ? categories : tags;
      await Promise.all([
        loadTaxonomy(type, current.page, current.pageSize),
        loadTaxonomyOptions(),
      ]);
    } catch (reason) {
      messageApi.error(contentError(reason, `${taxonomyName(type)}恢复失败`));
      if (isConflict(reason)) {
        const current = type === 'categories' ? categories : tags;
        await loadTaxonomy(type, current.page, current.pageSize);
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  function confirmEmergencyTakedown(record: DramaRecord): void {
    let reason = '';
    Modal.confirm({
      content: <Input.TextArea maxLength={2000} onChange={(event) => { reason = event.target.value; }} placeholder="填写必须立即停止全部代理商播放的原因" rows={4} showCount />,
      okButtonProps: { danger: true },
      okText: '立即停止全部播放',
      onOk: async () => {
        if (!reason.trim()) throw new Error('必须填写紧急下架原因');
        await request(`/api/v1/platform/public-drama-pool/${encodeURIComponent(record.id)}/emergency-takedown`, {
          body: JSON.stringify({ expectedVersion: record.version, reason: reason.trim() }),
          method: 'POST',
        });
        messageApi.success('已紧急下架，所有代理商立即停止播放');
        closeDetail();
        await loadDramas(dramas.page, dramas.pageSize);
      },
      title: `总部紧急下架：${translationValue(record.translations, 'title') || record.code}`,
    });
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>公共内容管理</Typography.Title>
          <Typography.Text type="secondary">
            管理平台自有短剧、剧集、分类与标签；平台内容直接发布，不经过代理商审核队列。
          </Typography.Text>
        </div>
      </div>
      <Alert
        className="page-alert"
        description="可直接选择文件安全上传，也可填写平台对象存储中已就绪的 Media Asset ID；不支持 external URL。"
        message="媒体安全边界"
        showIcon
        type="info"
      />
      <Tabs
        items={[
          {
            key: 'dramas', label: '公共短剧',
            children: (
              <DramaList
                canManage={canManage}
                canPublish={canPublish}
                data={dramas}
                error={dramaError}
                includeDeleted={includeDeletedDramas}
                loading={dramaLoading}
                onAction={(record, action) => void dramaAction(record, action)}
                onCreate={() => openDramaEditor()}
                onDelete={(record) => openDelete({ kind: 'drama', record })}
                onDetail={(record) => void openDetail(record)}
                onEdit={openDramaEditor}
                onEmergency={confirmEmergencyTakedown}
                onIncludeDeleted={setIncludeDeletedDramas}
                onPage={(page, pageSize) => void loadDramas(page, pageSize)}
                onRetry={() => void loadDramas(dramas.page, dramas.pageSize)}
                onRevision={openRevisionEditor}
                onStatus={setDramaStatus}
                status={dramaStatus}
                submitting={submitting}
              />
            ),
          },
          {
            key: 'categories', label: '分类',
            children: (
              <TaxonomyList
                canManage={canManage}
                data={categories}
                error={taxonomyError.categories}
                includeDeleted={includeDeletedCategories}
                loading={taxonomyLoading.categories}
                onCreate={() => openTaxonomyEditor('categories')}
                onDelete={(record) => openDelete({ kind: 'categories', record })}
                onEdit={(record) => openTaxonomyEditor('categories', record)}
                onIncludeDeleted={setIncludeDeletedCategories}
                onPage={(page, pageSize) => void loadTaxonomy('categories', page, pageSize)}
                onRetry={() => void loadTaxonomy('categories', categories.page, categories.pageSize)}
                onRestore={(record) => void restoreTaxonomy('categories', record)}
                submitting={submitting}
                type="categories"
              />
            ),
          },
          {
            key: 'tags', label: '标签',
            children: (
              <TaxonomyList
                canManage={canManage}
                data={tags}
                error={taxonomyError.tags}
                includeDeleted={includeDeletedTags}
                loading={taxonomyLoading.tags}
                onCreate={() => openTaxonomyEditor('tags')}
                onDelete={(record) => openDelete({ kind: 'tags', record })}
                onEdit={(record) => openTaxonomyEditor('tags', record)}
                onIncludeDeleted={setIncludeDeletedTags}
                onPage={(page, pageSize) => void loadTaxonomy('tags', page, pageSize)}
                onRetry={() => void loadTaxonomy('tags', tags.page, tags.pageSize)}
                onRestore={(record) => void restoreTaxonomy('tags', record)}
                submitting={submitting}
                type="tags"
              />
            ),
          },
        ]}
      />

      <Drawer
        destroyOnHidden
        loading={detailLoading}
        onClose={closeDetail}
        open={Boolean(selected)}
        title="公共短剧详情"
        width={880}
      >
        {detailError ? <RetryAlert message={detailError} onRetry={() => selected && void openDetail(selected)} />
          : selected ? (
            <DramaDetail
              canManage={canManage}
              onAddEpisode={() => openEpisodeEditor(selected)}
              onBatchEpisodes={canUploadEpisode ? () => setBatchDrama(selected) : undefined}
              onEditEpisode={(episode) => openEpisodeEditor(selected, episode)}
              onManageTracks={(episode) => openEpisodeTrackEditor(selected, episode)}
              record={selected}
            />
          ) : null}
      </Drawer>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeDramaEditor}
        open={Boolean(dramaEditor)}
        title={revisionSource ? `创建新版本：${revisionSource.code}` : dramaEditor === 'create' ? '创建公共短剧' : '编辑公共短剧'}
        width={760}
      >
        <Form form={dramaForm} layout="vertical" onFinish={(values) => void saveDrama(values)} preserve={false}>
          <Form.Item label="短剧 Code" name="code" rules={[
            { max: 128, min: 2, required: true },
            { pattern: /^[a-z0-9][a-z0-9_-]{1,127}$/, message: '仅支持小写字母、数字、_、-' },
          ]}><Input maxLength={128} /></Form.Item>
          {dramaEditor === 'create' ? (
            <>
              <Alert className="page-alert" message="闪创完结剧请同时填写作品、创作者和版本号。首版为 1；被代理商使用后只能通过“创建新版本”继续更新。" showIcon type="info" />
              <Form.Item label="闪创作品 ID" name="shanchuangWorkId"><Input disabled={Boolean(revisionSource)} maxLength={200} /></Form.Item>
              <Form.Item label="闪创创作者 ID" name="shanchuangCreatorId"><Input disabled={Boolean(revisionSource)} maxLength={200} /></Form.Item>
              <Space align="start" wrap>
                <Form.Item label="公共版本" name="publicRevision"><InputNumber disabled={Boolean(revisionSource)} min={1} precision={0} /></Form.Item>
                <Form.Item label="替代上一版本 Drama ID" name="supersedesDramaId"><Input disabled style={{ width: 330 }} /></Form.Item>
              </Space>
            </>
          ) : null}
          <Form.Item label="封面 Media Asset ID（可选）">
            <Space.Compact block>
              <Form.Item name="coverMediaAssetId" noStyle>
                <Input maxLength={36} placeholder="平台自有、image、ready 的 UUID" />
              </Form.Item>
              <Button htmlType="button" onClick={() => setUploadTarget('cover')}>上传图片</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item label="分类" name="categoryId">
            <Select allowClear options={taxonomyOptions(categoryOptions)} placeholder="可选平台分类" />
          </Form.Item>
          <Form.Item label="标签" name="tagIds">
            <Select mode="multiple" options={taxonomyOptions(tagOptions)} placeholder="最多 50 个平台标签" />
          </Form.Item>
          <ScheduleFields />
          <TranslationFields kind="drama" />
          <Button block htmlType="submit" loading={submitting === (dramaEditor === 'create' ? 'drama:create' : `drama:${(dramaEditor as DramaRecord | undefined)?.id}`)} type="primary">
            保存公共短剧
          </Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeEpisodeTrackEditor}
        open={Boolean(episodeTrackEditor)}
        title={`字幕与配音 · 第 ${episodeTrackEditor?.episode.episodeNo ?? '—'} 集`}
        width={760}
      >
        <Alert className="page-alert" message="同一类型和语言再次保存会更新原轨道；每种类型只能有一个默认轨道。字幕使用 WebVTT，配音使用常见音频格式。" showIcon type="info" />
        <Table<EpisodeTrackRecord>
          columns={[
            { dataIndex: 'type', title: '类型', width: 90, render: (value) => value === 'subtitle' ? '字幕' : '配音' },
            { dataIndex: 'locale', title: '语言', width: 100 },
            { dataIndex: 'label', title: '名称' },
            { dataIndex: 'isDefault', title: '默认', width: 70, render: (value) => value ? <Tag color="green">是</Tag> : '—' },
            { dataIndex: 'status', title: '状态', width: 80, render: (value) => value === 'active' ? <Tag color="blue">启用</Tag> : <Tag>停用</Tag> },
            { key: 'action', title: '操作', width: 90, render: (_, track) => track.status === 'active' ? (
              <Popconfirm onConfirm={() => void disableEpisodeTrack(track)} title="确认停用该轨道？">
                <Button danger loading={submitting === `track:disable:${track.id}`} size="small">停用</Button>
              </Popconfirm>
            ) : null },
          ]}
          dataSource={episodeTrackEditor?.episode.tracks ?? []}
          locale={{ emptyText: <Empty description="暂无字幕或配音" /> }}
          pagination={false}
          rowKey="id"
          size="small"
        />
        <Typography.Title level={5} style={{ marginTop: 24 }}>新增或更新轨道</Typography.Title>
        <Form form={episodeTrackForm} layout="vertical" onFinish={(values) => void saveEpisodeTrack(values)} preserve={false}>
          <Space align="start" wrap>
            <Form.Item label="类型" name="type" rules={[{ required: true }]}>
              <Select options={[{ label: '字幕', value: 'subtitle' }, { label: '配音', value: 'dubbing' }]} style={{ width: 120 }} />
            </Form.Item>
            <Form.Item label="语言代码" name="locale" rules={[
              { required: true, whitespace: true },
              { pattern: /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, message: '请输入 BCP 47 语言代码，如 en 或 es-MX' },
            ]}>
              <Input maxLength={35} placeholder="en / es-MX" style={{ width: 150 }} />
            </Form.Item>
            <Form.Item label="显示名称" name="label" rules={[{ max: 120, required: true, whitespace: true }]}>
              <Input maxLength={120} placeholder="English" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item label="设为默认" name="isDefault" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Form.Item label="Media Asset ID" required>
            <Space.Compact block>
              <Form.Item name="mediaAssetId" noStyle rules={[{ required: true, whitespace: true }]}>
                <Input maxLength={36} placeholder="平台自有、ready 的字幕或音频 UUID" />
              </Form.Item>
              <Button htmlType="button" onClick={() => setUploadTarget('track')}>上传文件</Button>
            </Space.Compact>
          </Form.Item>
          <Button block htmlType="submit" loading={Boolean(episodeTrackEditor && submitting === `track:create:${episodeTrackEditor.episode.id}`)} type="primary">保存轨道</Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeEpisodeEditor}
        open={Boolean(episodeEditor)}
        title={episodeEditor?.episode ? '编辑剧集' : '添加剧集'}
        width={720}
      >
        <Alert className="page-alert" message="上传正片后自动读取本集时长，无需手填。整部剧请使用详情页的“批量添加剧集”。试看为可选独立视频，不会从正片自动复制。" showIcon type="info" />
        <Form form={episodeForm} layout="vertical" onFinish={(values) => void saveEpisode(values)} preserve={false}>
          <Space align="start" wrap>
            <Form.Item label="集数" name="episodeNo" rules={[{ required: true }]}>
              <InputNumber max={1000} min={1} precision={0} />
            </Form.Item>
            <Form.Item label="视频时长（自动读取）" name="durationSeconds" rules={[{ required: true, message: '请先上传正片，自动读取时长' }]}>
              <InputNumber readOnly controls={false} placeholder="上传后识别" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item label="试看（秒）" name="previewSeconds">
              <InputNumber max={86400} min={0} precision={0} />
            </Form.Item>
          </Space>
          <Form.Item extra="必填；保存时验证为平台自有 ready 视频。" label="正片 Media Asset ID" required>
            <Space.Compact block>
              <Form.Item name="mediaAssetId" noStyle rules={[{ required: true }]}>
                <Input readOnly maxLength={36} placeholder="上传正片后自动填入" />
              </Form.Item>
              {canUploadEpisode ? <Button htmlType="button" onClick={() => setUploadTarget('episode-main')}>单独上传正片</Button> : null}
            </Space.Compact>
          </Form.Item>
          <Form.Item extra="可留空。编辑时清空并保存会 PATCH null；必须与正片 UUID 不同。" label="独立试看 Media Asset ID">
            <Space.Compact block>
              <Form.Item name="previewMediaAssetId" noStyle>
                <Input allowClear maxLength={36} placeholder="不配置则 H5 不提供试看" />
              </Form.Item>
              {canUploadEpisode ? <Button htmlType="button" onClick={() => setUploadTarget('episode-preview')}>单独上传试看</Button> : null}
            </Space.Compact>
          </Form.Item>
          <ScheduleFields />
          <TranslationFields kind="episode" />
          <Button block htmlType="submit" loading={Boolean(episodeEditor && submitting === (episodeEditor.episode ? `episode:${episodeEditor.episode.id}` : `episode:create:${episodeEditor.drama.id}`))} type="primary">
            保存剧集
          </Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeTaxonomyEditor}
        open={Boolean(taxonomyEditor)}
        title={`${taxonomyEditor?.record ? '编辑' : '创建'}${taxonomyName(taxonomyEditor?.type ?? 'categories')}`}
      >
        <Form form={taxonomyForm} layout="vertical" onFinish={(values) => void saveTaxonomy(values)} preserve={false}>
          <Form.Item label="Code" name="code" rules={[
            { max: 64, min: 2, required: true },
            { pattern: /^[a-z0-9][a-z0-9_-]{1,63}$/, message: '仅支持小写字母、数字、_、-' },
          ]}><Input maxLength={64} /></Form.Item>
          {taxonomyEditor?.type === 'categories' ? (
            <Form.Item label="排序" name="sortOrder" rules={[{ required: true }]}>
              <InputNumber max={1000000} min={-1000000} precision={0} />
            </Form.Item>
          ) : null}
          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select options={[{ label: '启用', value: 'active' }, { label: '停用', value: 'disabled' }]} />
          </Form.Item>
          <TranslationFields kind="taxonomy" />
          <Button block htmlType="submit" loading={Boolean(taxonomyEditor && submitting === (taxonomyEditor.record ? `${taxonomyEditor.type}:${taxonomyEditor.record.id}` : `${taxonomyEditor.type}:create`))} type="primary">
            保存{taxonomyName(taxonomyEditor?.type ?? 'categories')}
          </Button>
        </Form>
      </Modal>

      <Modal destroyOnHidden footer={null} onCancel={closeDelete} open={Boolean(deleteTarget)} title="确认软删除">
        <Alert className="page-alert" message={deleteTarget?.kind === 'drama'
          ? '发布中或已排期的短剧必须先下架。短剧软删除后可在 30 天恢复期内恢复。'
          : '被短剧引用的分类或标签不能删除；成功软删除后可在 30 天恢复期内恢复。'} showIcon type="warning" />
        <Form form={deleteForm} layout="vertical" onFinish={(values) => void deleteContent(values)} preserve={false}>
          <Form.Item label="删除原因" name="reason" rules={[{ max: 2000, required: true, whitespace: true }]}>
            <Input.TextArea maxLength={2000} rows={3} showCount />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmDelete }]} valuePropName="checked">
            <Checkbox>我确认软删除当前内容</Checkbox>
          </Form.Item>
          <Button block danger htmlType="submit" loading={Boolean(deleteTarget && submitting === `delete:${deleteTarget.kind}:${deleteTarget.record.id}`)} type="primary">确认软删除</Button>
        </Form>
      </Modal>

      <PlatformMediaUploadModal
        kind={uploadTarget === 'cover' ? 'image' : uploadTarget === 'track' ? 'file' : 'video'}
        onCancel={() => setUploadTarget(undefined)}
        onReady={(mediaId, durationSeconds) => {
          if (uploadTarget === 'cover') dramaForm.setFieldValue('coverMediaAssetId', mediaId);
          else if (uploadTarget === 'episode-main') episodeForm.setFieldsValue({ mediaAssetId: mediaId, durationSeconds });
          else if (uploadTarget === 'episode-preview') episodeForm.setFieldValue('previewMediaAssetId', mediaId);
          else episodeTrackForm.setFieldValue('mediaAssetId', mediaId);
          setUploadTarget(undefined);
          messageApi.success('文件已上传并由服务端验证为 ready，Media Asset ID 已填入表单');
        }}
        open={Boolean(uploadTarget)}
        purpose={uploadTarget}
      />
      {batchDrama && <BatchEpisodeUploadModal scope="platform" dramaId={batchDrama.id} onClose={() => {
        setBatchDrama(undefined);
        void loadDramas(dramas.page, dramas.pageSize);
        void openDetail(batchDrama);
      }} />}
    </>
  );
}

function DramaList({
  canManage,
  canPublish,
  data,
  error,
  includeDeleted,
  loading,
  onAction,
  onCreate,
  onDelete,
  onDetail,
  onEdit,
  onEmergency,
  onIncludeDeleted,
  onPage,
  onRetry,
  onRevision,
  onStatus,
  status,
  submitting,
}: {
  canManage: boolean;
  canPublish: boolean;
  data: PageResponse<DramaRecord>;
  error?: string;
  includeDeleted: boolean;
  loading: boolean;
  onAction(record: DramaRecord, action: 'publish' | 'restore' | 'unpublish'): void;
  onCreate(): void;
  onDelete(record: DramaRecord): void;
  onDetail(record: DramaRecord): void;
  onEdit(record: DramaRecord): void;
  onEmergency(record: DramaRecord): void;
  onIncludeDeleted(value: boolean): void;
  onPage(page: number, pageSize: number): void;
  onRetry(): void;
  onRevision(record: DramaRecord): void;
  onStatus(value: DramaStatus | undefined): void;
  status?: DramaStatus;
  submitting?: string;
}) {
  return (
    <>
      <div className="page-heading">
        <Space wrap>
          <Select
            allowClear
            onChange={onStatus}
            options={[
              { label: '草稿', value: 'draft' },
              { label: '已排期', value: 'approved' },
              { label: '已发布', value: 'published' },
              { label: '已下架', value: 'unpublished' },
              { label: '已拒绝/历史状态', value: 'rejected' },
            ]}
            placeholder="全部状态"
            style={{ width: 170 }}
            value={status}
          />
          <Space>
            <Switch checked={includeDeleted} onChange={onIncludeDeleted} />
            <Typography.Text>包含已删除</Typography.Text>
          </Space>
          <Button loading={loading} onClick={onRetry}>刷新</Button>
        </Space>
        {canManage ? <Button onClick={onCreate} type="primary">创建公共短剧</Button> : null}
      </div>
      {error ? <RetryAlert message={error} onRetry={onRetry} /> : null}
      <Table<DramaRecord>
        columns={[
          {
            key: 'drama', title: '短剧',
            render: (_, record) => (
              <Space direction="vertical" size={0}>
                <Button className="table-link-button" onClick={() => onDetail(record)} type="link">
                  {translationValue(record.translations, 'title') || record.code}
                </Button>
                <Typography.Text className="secondary-id" type="secondary">{record.code} · {record.id}</Typography.Text>
              </Space>
            ),
          },
          { dataIndex: 'status', title: '状态', width: 110, render: (value: DramaStatus, record) => (
            <Space direction="vertical" size={2}>
              <DramaStatusTag status={value} />
              {record.deletedAt ? <Tag color="red">已软删除</Tag> : null}
            </Space>
          ) },
          { dataIndex: 'totalEpisodes', title: '集数', width: 80 },
          { key: 'languages', title: '语言', width: 170, render: (_, record) => record.translations.map((item) => <Tag key={item.locale}>{item.locale}</Tag>) },
          { key: 'schedule', title: '发布计划', width: 220, render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>发布：{formatDateTime(record.releaseAt)}</Typography.Text>
              <Typography.Text type="secondary">下架：{formatDateTime(record.unpublishAt)}</Typography.Text>
            </Space>
          ) },
          { dataIndex: 'version', title: '版本', width: 70 },
          {
            key: 'actions', title: '操作', width: 420,
            render: (_, record) => (
              <Space wrap>
                <Button size="small" onClick={() => onDetail(record)}>详情</Button>
                {canManage && isDramaEditable(record.status, record.deletedAt)
                  ? <Button size="small" onClick={() => onEdit(record)}>编辑</Button> : null}
                {canManage && record.publicReleaseLockedAt && record.shanchuangWorkId
                  ? <Button size="small" onClick={() => onRevision(record)}>创建新版本</Button> : null}
                {canPublish && isDramaPublishable(record.status, record.deletedAt) ? (
                  <Popconfirm onConfirm={() => onAction(record, 'publish')} title={publishPrompt(record)}>
                    <Button loading={submitting === `publish:${record.id}`} size="small" type="primary">发布</Button>
                  </Popconfirm>
                ) : null}
                {canPublish && isDramaUnpublishable(record.status, record.deletedAt) ? (
                  <Popconfirm onConfirm={() => onAction(record, 'unpublish')} title="确认下架并取消待执行发布任务？">
                    <Button loading={submitting === `unpublish:${record.id}`} size="small">下架</Button>
                  </Popconfirm>
                ) : null}
                {canPublish && !record.deletedAt && record.status !== 'unpublished' ? (
                  <Button danger size="small" onClick={() => onEmergency(record)}>紧急全局下架</Button>
                ) : null}
                {canManage && !record.deletedAt && !['approved', 'published'].includes(record.status)
                  ? <Button danger size="small" onClick={() => onDelete(record)}>软删除</Button> : null}
                {canManage && isDramaRestorable(record.deletedAt, record.restoreUntil) ? (
                  <Popconfirm onConfirm={() => onAction(record, 'restore')} title="确认在恢复期限内恢复该短剧？">
                    <Button loading={submitting === `restore:${record.id}`} size="small">恢复</Button>
                  </Popconfirm>
                ) : null}
              </Space>
            ),
          },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无公共短剧" /> }}
        pagination={{
          current: data.page,
          onChange: onPage,
          pageSize: data.pageSize,
          pageSizeOptions: [20, 50, 100],
          showSizeChanger: true,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1250 }}
      />
    </>
  );
}

function TaxonomyList({
  canManage,
  data,
  error,
  includeDeleted,
  loading,
  onCreate,
  onDelete,
  onEdit,
  onIncludeDeleted,
  onPage,
  onRetry,
  onRestore,
  submitting,
  type,
}: {
  canManage: boolean;
  data: PageResponse<TaxonomyRecord>;
  error?: string;
  includeDeleted: boolean;
  loading: boolean;
  onCreate(): void;
  onDelete(record: TaxonomyRecord): void;
  onEdit(record: TaxonomyRecord): void;
  onIncludeDeleted(value: boolean): void;
  onPage(page: number, pageSize: number): void;
  onRetry(): void;
  onRestore(record: TaxonomyRecord): void;
  submitting?: string;
  type: TaxonomyType;
}) {
  return (
    <>
      <div className="page-heading">
        <Space wrap>
          <Space>
            <Switch checked={includeDeleted} onChange={onIncludeDeleted} />
            <Typography.Text>包含已删除</Typography.Text>
          </Space>
          <Button loading={loading} onClick={onRetry}>刷新</Button>
        </Space>
        {canManage ? <Button onClick={onCreate} type="primary">创建{taxonomyName(type)}</Button> : null}
      </div>
      {error ? <RetryAlert message={error} onRetry={onRetry} /> : null}
      <Table<TaxonomyRecord>
        columns={[
          { key: 'name', title: '名称', render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{translationValue(record.translations, 'name') || record.code}</Typography.Text>
              <Typography.Text className="secondary-id" type="secondary">{record.code} · {record.id}</Typography.Text>
            </Space>
          ) },
          { dataIndex: 'status', title: '状态', width: 100, render: (value, record) => (
            <Space direction="vertical" size={2}>
              {value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
              {record.deletedAt ? <Tag color="red">已删除</Tag> : null}
            </Space>
          ) },
          ...(type === 'categories' ? [{ dataIndex: 'sortOrder' as const, title: '排序', width: 90 }] : []),
          { key: 'languages', title: '语言', render: (_, record) => record.translations.map((item) => <Tag key={item.locale}>{item.locale}</Tag>) },
          { dataIndex: 'version', title: '版本', width: 80 },
          { key: 'actions', title: '操作', width: 180, render: (_, record) => record.deletedAt
            ? canManage && (!record.restoreUntil || isDramaRestorable(record.deletedAt, record.restoreUntil)) ? (
              <Popconfirm onConfirm={() => onRestore(record)} title={`确认恢复该${taxonomyName(type)}？恢复期由服务端最终校验。`}>
                <Button loading={submitting === `restore:${type}:${record.id}`} size="small">恢复</Button>
              </Popconfirm>
            ) : <Typography.Text type="secondary">已软删除（恢复期已过）</Typography.Text>
            : canManage ? (
              <Space>
                <Button size="small" onClick={() => onEdit(record)}>编辑</Button>
                <Button danger size="small" onClick={() => onDelete(record)}>软删除</Button>
              </Space>
            ) : <Typography.Text type="secondary">只读</Typography.Text> },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description={`暂无${taxonomyName(type)}`} /> }}
        pagination={{
          current: data.page,
          onChange: onPage,
          pageSize: data.pageSize,
          pageSizeOptions: [20, 50, 100],
          showSizeChanger: true,
          total: data.total,
        }}
        rowKey="id"
      />
    </>
  );
}

function DramaDetail({
  canManage,
  onAddEpisode,
  onBatchEpisodes,
  onEditEpisode,
  onManageTracks,
  record,
}: {
  canManage: boolean;
  onAddEpisode(): void;
  onBatchEpisodes?(): void;
  onEditEpisode(episode: EpisodeRecord): void;
  onManageTracks(episode: EpisodeRecord): void;
  record: DramaRecord;
}) {
  const editable = canManage && isDramaEditable(record.status, record.deletedAt);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="短剧 ID"><Typography.Text copyable>{record.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="Code">{record.code}</Descriptions.Item>
        <Descriptions.Item label="闪创作品 ID">{record.shanchuangWorkId ?? '非闪创公共剧'}</Descriptions.Item>
        <Descriptions.Item label="闪创创作者 ID">{record.shanchuangCreatorId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="公共版本">{record.publicRevision ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="替代上一版本">{record.supersedesDramaId ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="公共内容锁定时间">{formatDateTime(record.publicReleaseLockedAt)}</Descriptions.Item>
        <Descriptions.Item label="状态"><DramaStatusTag status={record.status} /> {record.deletedAt ? <Tag color="red">已软删除</Tag> : null}</Descriptions.Item>
        <Descriptions.Item label="封面 Media Asset ID">{record.coverMediaAssetId ? <Typography.Text copyable>{record.coverMediaAssetId}</Typography.Text> : '未设置'}</Descriptions.Item>
        <Descriptions.Item label="分类 ID">{record.categoryId ?? '未设置'}</Descriptions.Item>
        <Descriptions.Item label="标签 ID">{record.tagIds.length ? record.tagIds.map((id) => <Tag key={id}>{id}</Tag>) : '未设置'}</Descriptions.Item>
        <Descriptions.Item label="发布计划">{formatDateTime(record.releaseAt)}</Descriptions.Item>
        <Descriptions.Item label="下架计划">{formatDateTime(record.unpublishAt)}</Descriptions.Item>
        <Descriptions.Item label="删除时间">{formatDateTime(record.deletedAt)}</Descriptions.Item>
        <Descriptions.Item label="可恢复至">{formatDateTime(record.restoreUntil)}</Descriptions.Item>
        <Descriptions.Item label="版本">{record.version}</Descriptions.Item>
      </Descriptions>
      <div>
        <Typography.Title level={4}>多语言</Typography.Title>
        <Table<DramaTranslation>
          columns={[
            { dataIndex: 'locale', title: '语言', width: 100 },
            { dataIndex: 'title', title: '标题', width: 220 },
            { dataIndex: 'summary', title: '简介', ellipsis: true },
            { dataIndex: 'searchKeywords', title: '关键词', render: (value?: string[]) => value?.join('、') || '—' },
          ]}
          dataSource={record.translations}
          pagination={false}
          rowKey="locale"
          size="small"
        />
      </div>
      <div>
        <div className="page-heading">
          <Typography.Title level={4}>剧集</Typography.Title>
          {editable ? <Space><Button onClick={onAddEpisode}>添加单集</Button>{onBatchEpisodes && <Button onClick={onBatchEpisodes} type="primary">批量添加剧集</Button>}</Space> : null}
        </div>
        {!editable ? <Alert className="page-alert" message="发布中、已排期或已删除的短剧不能编辑剧集，请先下架。" showIcon type="info" /> : null}
        <Alert className="page-alert" message="媒体列显示绑定状态，不伪造实时转码状态；创建、更新和发布时服务端会重新验证正片与独立试看均为可用 ready 视频。" showIcon type="info" />
        <Table<EpisodeRecord>
          columns={[
            { dataIndex: 'episodeNo', title: '集数', width: 70 },
            { key: 'title', title: '标题', render: (_, episode) => translationValue(episode.translations, 'title') || `第 ${episode.episodeNo} 集` },
            { dataIndex: 'status', title: '状态', width: 100, render: (value) => <DramaStatusTag status={value as DramaStatus} /> },
            { key: 'time', title: '时长/试看', width: 120, render: (_, episode) => `${episode.durationSeconds}s / ${episode.previewSeconds}s` },
            { dataIndex: 'mediaAssetId', title: '正片媒体（绑定状态）', width: 300, render: (value) => <Space direction="vertical" size={2}><Tag color="green">已绑定，保存时校验 ready</Tag><Typography.Text copyable>{value}</Typography.Text></Space> },
            { dataIndex: 'previewMediaAssetId', title: '独立试看媒体（绑定状态）', width: 300, render: (value?: string) => value ? <Space direction="vertical" size={2}><Tag color="blue">独立试看已绑定</Tag><Typography.Text copyable>{value}</Typography.Text></Space> : <Tag>未配置，不回退正片</Tag> },
            { dataIndex: 'releaseAt', title: '发布时间', width: 180, render: formatDateTime },
            { dataIndex: 'version', title: '版本', width: 70 },
            { key: 'action', title: '操作', width: 180, render: (_, episode) => editable
              ? <Space><Button size="small" onClick={() => onEditEpisode(episode)}>编辑</Button><Button size="small" onClick={() => onManageTracks(episode)}>字幕/配音</Button></Space>
              : <Typography.Text type="secondary">只读</Typography.Text> },
          ]}
          dataSource={record.episodes ?? []}
          locale={{ emptyText: <Empty description="暂无剧集" /> }}
          pagination={false}
          rowKey="id"
          scroll={{ x: 1450 }}
          size="small"
        />
      </div>
    </Space>
  );
}

function ScheduleFields() {
  return (
    <>
      <Alert className="page-alert" message="定时发布由 releaseAt 控制；unpublishAt 必须晚于 releaseAt。留空表示不排期。" showIcon type="info" />
      <Form.Item label="发布时间（标准 ISO，可选）" name="releaseAt">
        <Input placeholder="2026-08-22T12:00:00.000Z" />
      </Form.Item>
      <Form.Item label="下架时间（标准 ISO，可选）" name="unpublishAt">
        <Input placeholder="2026-09-22T12:00:00.000Z" />
      </Form.Item>
    </>
  );
}

function TranslationFields({ kind }: { kind: 'drama' | 'episode' | 'taxonomy' }) {
  return (
    <Form.List name="translations">
      {(fields, { add, remove }) => (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div className="page-heading">
            <Typography.Title level={5}>多语言（至少 1 种）</Typography.Title>
            <Button disabled={fields.length >= contentLocaleOptions.length} onClick={() => add()} size="small">添加语言</Button>
          </div>
          {fields.map((field) => (
            <div className="audit-filter-card" key={field.key}>
              <Space align="start" wrap>
                <Form.Item label="语言" name={[field.name, 'locale']} rules={[{ required: true }]}>
                  <Select options={contentLocaleOptions} style={{ width: 150 }} />
                </Form.Item>
                <Form.Item
                  label={kind === 'taxonomy' ? '名称' : '标题'}
                  name={[field.name, kind === 'taxonomy' ? 'name' : 'title']}
                  rules={[{ max: kind === 'taxonomy' ? 200 : 300, required: true, whitespace: true }]}
                >
                  <Input maxLength={kind === 'taxonomy' ? 200 : 300} style={{ width: 280 }} />
                </Form.Item>
                <Button danger disabled={fields.length <= 1} onClick={() => remove(field.name)} size="small">移除</Button>
              </Space>
              {kind === 'drama' ? (
                <>
                  <Form.Item label="简介" name={[field.name, 'summary']} rules={[{ max: 20000 }]}>
                    <Input.TextArea maxLength={20000} rows={3} showCount />
                  </Form.Item>
                  <Form.Item extra="英文逗号分隔，最多 50 个" label="搜索关键词" name={[field.name, 'searchKeywords']}>
                    <Input maxLength={5000} />
                  </Form.Item>
                </>
              ) : null}
            </div>
          ))}
        </Space>
      )}
    </Form.List>
  );
}

interface PlatformStorageProvider {
  id: string;
  label: string;
  ownerType: 'platform';
  status: 'active' | 'disabled';
}

interface UploadIntent {
  expiresAt: string;
  id: string;
  method: 'PUT';
  requiredHeaders: Record<string, string>;
  status: 'uploading';
  uploadUrl: string;
}

function PlatformMediaUploadModal({
  kind,
  onCancel,
  onReady,
  open,
  purpose,
}: {
  kind: 'file' | 'image' | 'video';
  onCancel(): void;
  onReady(mediaId: string, durationSeconds?: number): void;
  open: boolean;
  purpose?: UploadTarget;
}) {
  const { principal, request } = useAuth();
  const [providerId, setProviderId] = useState('');
  const [providers, setProviders] = useState<PlatformStorageProvider[]>([]);
  const [file, setFile] = useState<File>();
  const [stage, setStage] = useState<string>();
  const [hashProgress, setHashProgress] = useState(0);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const canReadStorage = principal?.permissions.includes('platform.storage.read') ?? false;

  useEffect(() => {
    if (!open) return;
    setFile(undefined);
    setStage(undefined);
    setHashProgress(0);
    setError(undefined);
    if (!canReadStorage) return;
    let active = true;
    void request<PageResponse<PlatformStorageProvider>>(
      '/api/v1/platform/storage/providers?page=1&pageSize=100',
    ).then((result) => {
      if (!active) return;
      const available = result.items.filter((provider) => provider.status === 'active');
      setProviders(available);
      setProviderId((current) => current || available[0]?.id || '');
    }).catch(() => {
      if (active) setProviders([]);
    });
    return () => { active = false; };
  }, [canReadStorage, open, request]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function cancel(): void {
    abortRef.current?.abort();
    abortRef.current = undefined;
    setFile(undefined);
    setStage(undefined);
    setHashProgress(0);
    setError(undefined);
    onCancel();
  }

  async function upload(): Promise<void> {
    if (!file || !isUuid(providerId.trim())) {
      setError(!file ? '请选择需要上传的文件' : 'Provider ID 必须是 UUID');
      return;
    }
    const validation = validateContentUploadFile(file, kind);
    if (validation) {
      setError(validation);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setError(undefined);
    try {
      if (kind === 'video') {
        setStage('正在读取视频实际时长');
        const durationSeconds = await readVideoDuration(file, controller.signal);
        const mediaId = await uploadEpisodeFile(file, providerId.trim(), API_BASE, request, controller.signal, setStage);
        if (controller.signal.aborted) return;
        abortRef.current = undefined;
        onReady(mediaId, durationSeconds);
        return;
      }
      setStage('正在分块计算 SHA-256，不会把整个大文件一次载入内存');
      const checksumSha256 = await sha256Blob(file, {
        onProgress: (ratio) => setHashProgress(Math.round(ratio * 100)),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStage('正在申请一次性直传地址');
      const intent = await request<UploadIntent>(`${API_BASE}/media/uploads`, {
        body: JSON.stringify({
          checksumSha256,
          contentType: file.type,
          extension: contentFileExtension(file.name),
          kind,
          providerId: providerId.trim(),
          sizeBytes: file.size,
        }),
        method: 'POST',
      });
      validateContentUploadIntent(intent, file, isUuid);
      setStage('正在直传对象存储；完成前不会把 Media ID 视为 ready');
      const uploadResponse = await fetch(intent.uploadUrl, {
        body: file,
        credentials: 'omit',
        headers: contentUploadHeaders(intent.requiredHeaders, file),
        method: 'PUT',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!uploadResponse.ok) {
        throw new Error(`对象存储直传失败（HTTP ${uploadResponse.status}）`);
      }
      setStage('正在由服务端核验大小、类型和 SHA-256');
      const completed = await request<{ id: string; status: string }>(
        `${API_BASE}/media/uploads/${encodeURIComponent(intent.id)}/complete`,
        { method: 'POST' },
      );
      if (completed.id !== intent.id || completed.status !== 'ready') {
        throw new Error('服务端尚未把媒体验证为 ready');
      }
      abortRef.current = undefined;
      onReady(completed.id);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(uploadError(reason));
      setStage(undefined);
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
    }
  }

  return (
    <Modal
      destroyOnHidden
      footer={null}
      maskClosable={!stage}
      onCancel={cancel}
      open={open}
      title={kind === 'image' ? '上传平台封面图片' : kind === 'file' ? '上传字幕或配音文件' : purpose === 'episode-preview' ? '单独上传平台试看短片' : '单独上传平台正片视频'}
      width={620}
    >
      <Alert
        className="page-alert"
        message="上传流程为：本地分块校验 → S3 条件直传 → 服务端 HEAD 核验 → ready。不会使用外链，也不会跳过完成核验。"
        showIcon
        type="info"
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>平台对象存储 Provider ID</Typography.Text>
          <Input
            disabled={Boolean(stage)}
            list="platform-content-storage-providers"
            maxLength={36}
            onChange={(event) => setProviderId(event.target.value)}
            placeholder="平台已启用 S3 Provider UUID"
            value={providerId}
          />
          <datalist id="platform-content-storage-providers">
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </datalist>
          {!canReadStorage ? (
            <Typography.Text type="secondary">当前账号没有存储配置读取权限，请输入管理员提供的平台 Provider UUID。</Typography.Text>
          ) : null}
        </div>
        <div>
          <Typography.Text strong>{kind === 'image' ? '图片文件' : kind === 'video' ? '视频文件' : '字幕或配音文件'}</Typography.Text>
          <Input
            accept={kind === 'image'
              ? 'image/avif,image/jpeg,image/png,image/webp'
              : kind === 'video'
                ? 'video/mp4,video/quicktime,video/webm'
                : '.vtt,audio/aac,audio/flac,audio/mp4,audio/mpeg,audio/ogg,audio/wav'}
            disabled={Boolean(stage)}
            onChange={(event) => setFile(event.target.files?.[0])}
            type="file"
          />
          <Typography.Text type="secondary">
            {kind === 'image' ? 'AVIF/JPEG/PNG/WebP，最大 25 MiB' : kind === 'video' ? 'MP4/MOV/WebM，最大 2 GiB' : 'WebVTT 或 AAC/FLAC/M4A/MP3/OGG/WAV，最大 100 MiB'}
          </Typography.Text>
        </div>
        {file ? <Typography.Text>已选择：{file.name}（{formatContentBytes(file.size)}）</Typography.Text> : null}
        {stage ? (
          <div>
            <Typography.Text>{stage}</Typography.Text>
            {kind !== 'video' && hashProgress < 100 ? <Progress percent={hashProgress} size="small" /> : null}
          </div>
        ) : null}
        {error ? <Alert message={error} showIcon type="error" /> : null}
        <Button block disabled={Boolean(stage)} onClick={() => void upload()} type="primary">
          开始安全上传
        </Button>
        {stage ? <Button block danger onClick={cancel}>取消上传</Button> : null}
      </Space>
    </Modal>
  );
}

function uploadError(reason: unknown): string {
  if (reason instanceof ApiError) return contentError(reason, '媒体上传接口调用失败');
  return reason instanceof Error ? reason.message : '媒体上传失败';
}

function RetryAlert({ message: text, onRetry }: { message: string; onRetry(): void }) {
  return <Alert action={<Button size="small" onClick={onRetry}>重试</Button>} className="page-alert" message={text} showIcon type="error" />;
}

function DramaStatusTag({ status }: { status: DramaStatus }) {
  const option = {
    approved: { color: 'processing', text: '已排期' },
    draft: { color: undefined, text: '草稿' },
    published: { color: 'green', text: '已发布' },
    rejected: { color: 'orange', text: '历史拒绝状态' },
    unpublished: { color: 'blue', text: '已下架' },
  }[status];
  return <Tag color={option.color}>{option.text}</Tag>;
}

function translationValue<T extends { locale: ContentLocale }>(
  translations: T[],
  field: keyof T,
): string | undefined {
  const preferred = translations.find((item) => item.locale === 'zh-CN') ?? translations[0];
  const value = preferred?.[field];
  return typeof value === 'string' ? value : undefined;
}

function taxonomyOptions(records: TaxonomyRecord[]) {
  return records.map((record) => ({
    label: `${translationValue(record.translations, 'name') ?? record.code} · ${record.code}`,
    value: record.id,
  }));
}

function normalizeDramaTranslations(translations: DramaTranslation[]) {
  return translations.map((translation) => ({
    locale: translation.locale,
    searchKeywords: translation.searchKeywords ?? [],
    summary: translation.summary ?? '',
    title: translation.title,
  }));
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function taxonomyName(type: TaxonomyType): string {
  return type === 'categories' ? '分类' : '标签';
}

function publishPrompt(record: DramaRecord): string {
  if (record.releaseAt && new Date(record.releaseAt).getTime() > Date.now()) {
    return `确认按 ${formatDateTime(record.releaseAt)} 建立发布计划？`;
  }
  return '确认立即发布该公共短剧？';
}

function assertSchedule(releaseAt?: string, unpublishAt?: string): void {
  if (unpublishAt && (!releaseAt || unpublishAt <= releaseAt)) {
    throw new Error('下架时间必须晚于发布时间，且设置下架时间时必须设置发布时间');
  }
}

function formatDateTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

async function confirmDelete(_: unknown, value: boolean): Promise<void> {
  if (!value) throw new Error('请先确认软删除操作');
}

function contentError(reason: unknown, fallback: string): string {
  if (!(reason instanceof ApiError)) return fallback;
  if (reason.status === 401) return '登录状态已失效，请重新登录';
  if (reason.status === 403) return '当前账号没有执行该操作的权限';
  if (reason.status === 409) return '数据版本或状态已变化，页面将刷新，请重新操作';
  if ([400, 404].includes(reason.status) && reason.message) return reason.message;
  return fallback;
}

function isConflict(reason: unknown): boolean {
  return isContentVersionConflict(reason);
}

function localError(reason: unknown): string {
  return reason instanceof Error ? reason.message : '输入内容无效';
}
