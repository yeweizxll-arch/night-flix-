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
import { DramaRankingButton } from './DramaRankingButton';
import { uploadEpisodeFile } from './batch-episodes';
import { readVideoDuration } from './video-duration';
import {
  contentFileExtension,
  contentUploadHeaders,
  type ContentUploadIntent,
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
import { sha256Blob } from './file-sha256';
import {
  assertUniqueLocales,
  contentLocaleOptions,
  type ContentLocale,
  isUuid,
  keywordList,
  optionalCanonicalIso,
} from './platform-content-library-ui';
import {
  isTenantDramaEditable,
  readContentImportFile,
  safeExportFilename,
  safeImportErrors,
} from './tenant-content-ui';

const API_BASE = '/api/v1/tenant/content';
const STORAGE_API = '/api/v1/tenant/storage/providers';

type DramaStatus =
  | 'approved'
  | 'draft'
  | 'pending_review'
  | 'published'
  | 'rejected'
  | 'unpublished';
type TaxonomyType = 'categories' | 'tags';
type ImportFormat = 'csv' | 'json';
type UploadTarget = 'cover' | 'episode-main' | 'episode-preview';

interface DramaTranslation {
  locale: ContentLocale;
  searchKeywords?: string[];
  summary?: string;
  title: string;
}

interface EpisodeTranslation { locale: ContentLocale; title: string }

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
  translations: EpisodeTranslation[];
  unpublishAt?: string;
  version: number;
}

interface DramaRecord {
  categoryId?: string;
  code: string;
  coverFileId?: string;
  createdAt: string;
  deletedAt?: string;
  episodes?: EpisodeRecord[];
  id: string;
  releaseAt?: string;
  restoreUntil?: string;
  sourceType: string;
  status: DramaStatus;
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
  ownerType: 'platform' | 'tenant';
  restoreUntil?: string;
  sortOrder?: number;
  status: 'active' | 'disabled';
  translations: TaxonomyTranslation[];
  version: number;
}

interface ImportJob {
  completedAt?: string;
  createdAt: string;
  format: ImportFormat;
  id: string;
  status: 'cancelled' | 'completed' | 'failed' | 'importing' | 'ready' | 'uploaded' | 'validating';
  summary?: unknown;
  validatedAt?: string;
  version: number;
}

interface ImportRow {
  errors?: unknown;
  importedDramaId?: string;
  rowNumber: number;
  status: string;
}

interface ImportDetail extends ImportJob {
  page: number;
  pageSize: number;
  rows: ImportRow[];
}

interface PageResponse<T> { items: T[]; page: number; pageSize: number; total: number }

interface DramaTranslationForm extends Omit<DramaTranslation, 'searchKeywords'> {
  searchKeywords?: string;
}

interface DramaFormValue {
  categoryId?: string;
  code: string;
  coverFileId?: string;
  releaseAt?: string;
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

interface TaxonomyFormValue {
  code: string;
  sortOrder?: number;
  status: 'active' | 'disabled';
  translations: TaxonomyTranslation[];
}

interface DeleteFormValue { confirmed: boolean; reason: string }
type TaxonomyEditor = { record?: TaxonomyRecord; type: TaxonomyType };
type DeleteTarget =
  | { kind: 'drama'; record: DramaRecord }
  | { kind: TaxonomyType; record: TaxonomyRecord };

interface TenantStorageProvider {
  id: string;
  label: string;
  ownerType: 'platform' | 'tenant';
  readOnly: boolean;
  status: 'active' | 'disabled';
}

interface UploadIntent extends ContentUploadIntent {
  completionVerificationRequired?: true;
}

interface ExportResponse {
  content: string;
  contentType: string;
  filename: string;
  format: ImportFormat;
  rowCount: number;
}

const emptyDramas: PageResponse<DramaRecord> = { items: [], page: 1, pageSize: 20, total: 0 };
const emptyTaxonomy: PageResponse<TaxonomyRecord> = { items: [], page: 1, pageSize: 20, total: 0 };
const emptyImports: PageResponse<ImportJob> = { items: [], page: 1, pageSize: 20, total: 0 };

export function TenantContentListPage() {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [dramaForm] = Form.useForm<DramaFormValue>();
  const [episodeForm] = Form.useForm<EpisodeFormValue>();
  const [taxonomyForm] = Form.useForm<TaxonomyFormValue>();
  const [deleteForm] = Form.useForm<DeleteFormValue>();
  const [dramas, setDramas] = useState(emptyDramas);
  const [categories, setCategories] = useState(emptyTaxonomy);
  const [tags, setTags] = useState(emptyTaxonomy);
  const [imports, setImports] = useState(emptyImports);
  const [categoryOptions, setCategoryOptions] = useState<TaxonomyRecord[]>([]);
  const [tagOptions, setTagOptions] = useState<TaxonomyRecord[]>([]);
  const [includeDeletedDramas, setIncludeDeletedDramas] = useState(false);
  const [includeDeletedCategories, setIncludeDeletedCategories] = useState(false);
  const [includeDeletedTags, setIncludeDeletedTags] = useState(false);
  const [importStatus, setImportStatus] = useState<ImportJob['status']>();
  const [dramaLoading, setDramaLoading] = useState(true);
  const [taxonomyLoading, setTaxonomyLoading] = useState<Record<TaxonomyType, boolean>>({ categories: true, tags: true });
  const [importLoading, setImportLoading] = useState(true);
  const [dramaError, setDramaError] = useState<string>();
  const [taxonomyError, setTaxonomyError] = useState<Partial<Record<TaxonomyType, string>>>({});
  const [importError, setImportError] = useState<string>();
  const [selected, setSelected] = useState<DramaRecord>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [selectedImport, setSelectedImport] = useState<ImportDetail>();
  const [importDetailLoading, setImportDetailLoading] = useState(false);
  const [importDetailError, setImportDetailError] = useState<string>();
  const [dramaEditor, setDramaEditor] = useState<'create' | DramaRecord>();
  const [episodeEditor, setEpisodeEditor] = useState<{ drama: DramaRecord; episode?: EpisodeRecord }>();
  const [taxonomyEditor, setTaxonomyEditor] = useState<TaxonomyEditor>();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [uploadTarget, setUploadTarget] = useState<UploadTarget>();
  const [batchDrama, setBatchDrama] = useState<DramaRecord>();
  const [importOpen, setImportOpen] = useState(false);
  const [importFormat, setImportFormat] = useState<ImportFormat>('json');
  const [importFile, setImportFile] = useState<File>();
  const [submitting, setSubmitting] = useState<string>();
  const dramaSequence = useRef(0);
  const detailSequence = useRef(0);
  const taxonomySequence = useRef<Record<TaxonomyType, number>>({ categories: 0, tags: 0 });
  const importSequence = useRef(0);
  const importDetailSequence = useRef(0);
  const dramaPageSize = useRef(20);
  const taxonomyPageSize = useRef<Record<TaxonomyType, number>>({ categories: 20, tags: 20 });
  const importPageSize = useRef(20);

  const permissions = principal?.permissions ?? [];
  const canRead = permissions.includes('content.drama.read');
  const canCreate = permissions.includes('content.drama.create');
  const canUpdate = permissions.includes('content.drama.update');
  const canSubmitReview = permissions.includes('content.drama.submit_review');
  const canUploadEpisode = canUploadEpisodeMedia('tenant', permissions);

  const loadDramas = useCallback(async (page = 1, pageSize = dramaPageSize.current) => {
    if (!canRead) return;
    const sequence = ++dramaSequence.current;
    dramaPageSize.current = pageSize;
    setDramaLoading(true);
    setDramaError(undefined);
    try {
      const result = await request<PageResponse<DramaRecord>>(
        `${API_BASE}/dramas?page=${page}&pageSize=${pageSize}&deleted=${includeDeletedDramas}`,
      );
      if (sequence === dramaSequence.current) setDramas(result);
    } catch (reason) {
      if (sequence === dramaSequence.current) setDramaError(contentError(reason, '短剧列表加载失败'));
    } finally {
      if (sequence === dramaSequence.current) setDramaLoading(false);
    }
  }, [canRead, includeDeletedDramas, request]);

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
    const includeDeleted = type === 'categories' ? includeDeletedCategories : includeDeletedTags;
    try {
      const result = await request<PageResponse<TaxonomyRecord>>(
        `${API_BASE}/${type}?page=${page}&pageSize=${pageSize}&deleted=${includeDeleted}&scope=all`,
      );
      if (sequence !== taxonomySequence.current[type]) return;
      if (type === 'categories') setCategories(result);
      else setTags(result);
    } catch (reason) {
      if (sequence === taxonomySequence.current[type]) {
        setTaxonomyError((current) => ({
          ...current,
          [type]: contentError(reason, `${taxonomyName(type)}列表加载失败`),
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
        request<PageResponse<TaxonomyRecord>>(`${API_BASE}/categories?page=1&pageSize=100&deleted=false&scope=all`),
        request<PageResponse<TaxonomyRecord>>(`${API_BASE}/tags?page=1&pageSize=100&deleted=false&scope=all`),
      ]);
      setCategoryOptions(categoryResult.items.filter((item) => item.status === 'active' && !item.deletedAt));
      setTagOptions(tagResult.items.filter((item) => item.status === 'active' && !item.deletedAt));
    } catch {
      // The full taxonomy tabs expose errors; already attached UUIDs remain visible in editors.
    }
  }, [canRead, request]);

  const loadImports = useCallback(async (page = 1, pageSize = importPageSize.current) => {
    if (!canRead) return;
    const sequence = ++importSequence.current;
    importPageSize.current = pageSize;
    setImportLoading(true);
    setImportError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (importStatus) query.set('status', importStatus);
    try {
      const result = await request<PageResponse<ImportJob>>(`${API_BASE}/imports?${query}`);
      if (sequence === importSequence.current) setImports(result);
    } catch (reason) {
      if (sequence === importSequence.current) setImportError(contentError(reason, '导入任务加载失败'));
    } finally {
      if (sequence === importSequence.current) setImportLoading(false);
    }
  }, [canRead, importStatus, request]);

  useEffect(() => { void loadDramas(1); }, [loadDramas]);
  useEffect(() => { void loadTaxonomy('categories', 1); }, [loadTaxonomy]);
  useEffect(() => { void loadTaxonomy('tags', 1); }, [loadTaxonomy]);
  useEffect(() => { void loadTaxonomyOptions(); }, [loadTaxonomyOptions]);
  useEffect(() => { void loadImports(1); }, [loadImports]);

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
    episodeForm.resetFields();
  }

  async function openImportDetail(job: ImportJob, page = 1): Promise<void> {
    const sequence = ++importDetailSequence.current;
    setSelectedImport((current) => current?.id === job.id ? current : { ...job, page: 1, pageSize: 50, rows: [] });
    setImportDetailLoading(true);
    setImportDetailError(undefined);
    try {
      const result = await request<ImportDetail>(
        `${API_BASE}/imports/${encodeURIComponent(job.id)}?page=${page}&pageSize=50`,
      );
      if (sequence === importDetailSequence.current) setSelectedImport(result);
    } catch (reason) {
      if (sequence === importDetailSequence.current) setImportDetailError(contentError(reason, '导入详情加载失败'));
    } finally {
      if (sequence === importDetailSequence.current) setImportDetailLoading(false);
    }
  }

  function closeImportDetail(): void {
    importDetailSequence.current += 1;
    setSelectedImport(undefined);
    setImportDetailError(undefined);
  }

  function openDramaEditor(record?: DramaRecord): void {
    dramaForm.resetFields();
    dramaForm.setFieldsValue(record ? {
      categoryId: record.categoryId,
      code: record.code,
      coverFileId: record.coverFileId,
      releaseAt: record.releaseAt,
      tagIds: record.tagIds,
      translations: record.translations.map((translation) => ({
        ...translation,
        searchKeywords: translation.searchKeywords?.join(', '),
      })),
      unpublishAt: record.unpublishAt,
    } : {
      tagIds: [],
      translations: [{ locale: 'zh-CN', searchKeywords: '', summary: '', title: '' }],
    });
    setDramaEditor(record ?? 'create');
  }

  function closeDramaEditor(): void {
    setDramaEditor(undefined);
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
      if (values.coverFileId?.trim() && !isUuid(values.coverFileId.trim())) {
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
      const coverFileId = values.coverFileId?.trim() || null;
      if (normalizedCode !== target.code) payload.code = normalizedCode;
      if (categoryId !== (target.categoryId ?? null)) payload.categoryId = categoryId;
      if (coverFileId !== (target.coverFileId ?? null)) payload.coverFileId = coverFileId;
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
    } else {
      payload = {
        categoryId: values.categoryId || undefined,
        code: normalizedCode,
        coverFileId: values.coverFileId?.trim() || undefined,
        releaseAt,
        sourceType: 'upload',
        tagIds: values.tagIds ?? [],
        translations,
        unpublishAt,
      };
    }
    setSubmitting(target ? `drama:${target.id}` : 'drama:create');
    try {
      const result = await request<DramaRecord>(
        target ? `${API_BASE}/dramas/${encodeURIComponent(target.id)}` : `${API_BASE}/dramas`,
        { body: JSON.stringify(payload), method: target ? 'PATCH' : 'POST' },
      );
      messageApi.success(target ? '短剧已更新' : '短剧草稿已创建');
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
      if (JSON.stringify(translations) !== JSON.stringify(episode.translations)) payload.translations = translations;
      if (Object.keys(payload).length === 1) {
        messageApi.info('没有需要保存的剧集变更');
        return;
      }
    } else {
      payload = {
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
    }
    setSubmitting(episode ? `episode:${episode.id}` : `episode:create:${drama.id}`);
    try {
      const base = `${API_BASE}/dramas/${encodeURIComponent(drama.id)}/episodes`;
      await request(episode ? `${base}/${encodeURIComponent(episode.id)}` : base, {
        body: JSON.stringify(payload),
        method: episode ? 'PATCH' : 'POST',
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

  async function dramaAction(record: DramaRecord, action: 'restore' | 'publish' | 'unpublish' | 'withdraw') {
    setSubmitting(`${action}:${record.id}`);
    const actionPath = action === 'withdraw' ? 'withdraw-review' : action;
    try {
      await request(`${API_BASE}/dramas/${encodeURIComponent(record.id)}/${actionPath}`, {
        method: 'POST',
        ...(action !== 'withdraw' ? { body: JSON.stringify({ expectedVersion: record.version }) } : {}),
      });
      messageApi.success(action === 'publish'
        ? '已确认上架（如有未来发布时间，将定时上架）'
        : action === 'unpublish' ? '短剧已下架，已取消旧定时任务'
        : action === 'withdraw' ? '旧审核已撤回，短剧恢复草稿' : '短剧已恢复');
      await loadDramas(dramas.page, dramas.pageSize);
      if (selected?.id === record.id) await openDetail(record);
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
    if (record?.ownerType === 'platform') return;
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
      translations: values.translations.map((translation) => ({ ...translation, name: translation.name.trim() })),
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
    const body = { expectedVersion: record.version, reason: values.reason.trim() };
    setSubmitting(`delete:${kind}:${record.id}`);
    try {
      await request(path, { body: JSON.stringify(body), method: 'DELETE' });
      messageApi.success(kind === 'drama'
        ? '短剧已软删除，可在 30 天恢复期内恢复'
        : `${taxonomyName(kind)}已软删除，可在服务端允许的恢复期内恢复`);
      closeDelete();
      if (kind === 'drama') {
        closeDetail();
        await loadDramas(dramas.page, dramas.pageSize);
      } else {
        const current = kind === 'categories' ? categories : tags;
        await Promise.all([loadTaxonomy(kind, current.page, current.pageSize), loadTaxonomyOptions()]);
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
    if (record.ownerType !== 'tenant') return;
    setSubmitting(`restore:${type}:${record.id}`);
    try {
      await request(`${API_BASE}/${type}/${encodeURIComponent(record.id)}/restore`, {
        body: JSON.stringify({ expectedVersion: record.version }),
        method: 'POST',
      });
      messageApi.success(`${taxonomyName(type)}已恢复`);
      const current = type === 'categories' ? categories : tags;
      await Promise.all([loadTaxonomy(type, current.page, current.pageSize), loadTaxonomyOptions()]);
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

  async function createImport(): Promise<void> {
    if (!importFile) {
      messageApi.error('请选择不超过 1 MiB 的 JSON 或 CSV 纯文本文件');
      return;
    }
    setSubmitting('import:create');
    try {
      const payload = await readContentImportFile(importFile);
      await request<ImportJob>(`${API_BASE}/imports`, {
        body: JSON.stringify({ format: importFormat, payload }),
        method: 'POST',
      });
      setImportOpen(false);
      setImportFile(undefined);
      messageApi.success('导入任务已提交，后端正在异步校验和处理');
      await loadImports(1, imports.pageSize);
    } catch (reason) {
      messageApi.error(contentError(reason, localError(reason, '导入任务提交失败')));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function exportContent(format: ImportFormat): Promise<void> {
    setSubmitting(`export:${format}`);
    try {
      const result = await request<ExportResponse>(`${API_BASE}/export?format=${format}`);
      const expectedType = format === 'json'
        ? 'application/json; charset=utf-8'
        : 'text/csv; charset=utf-8';
      if (result.format !== format || result.contentType !== expectedType
        || typeof result.content !== 'string' || !Number.isSafeInteger(result.rowCount)) {
        throw new Error('服务端返回了无效的导出结果');
      }
      const blob = new Blob([result.content], { type: expectedType });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = safeExportFilename(result.filename, format);
        anchor.rel = 'noopener';
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      messageApi.success(`已安全导出 ${result.rowCount} 部短剧`);
    } catch (reason) {
      messageApi.error(contentError(reason, localError(reason, '内容导出失败')));
    } finally {
      setSubmitting(undefined);
    }
  }

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>代理商内容管理</Typography.Title>
          <Typography.Text type="secondary">
            管理本代理商的短剧、剧集、分类标签、S3 直传及安全导入导出。
          </Typography.Text>
        </div>
      </div>
      <Alert
        className="page-alert"
        description="媒体只能通过已启用的 S3 Provider 直传，并在服务端校验为 ready 后使用；外链登记入口已停用。"
        message="媒体安全边界"
        showIcon
        type="info"
      />
      <Tabs items={[
        {
          key: 'dramas',
          label: '短剧与剧集',
          children: (
            <DramaList
              canCreate={canCreate}
              canSubmitReview={canSubmitReview}
              canUpdate={canUpdate}
              data={dramas}
              error={dramaError}
              includeDeleted={includeDeletedDramas}
              loading={dramaLoading}
              onAction={(record, action) => void dramaAction(record, action)}
              onCreate={() => openDramaEditor()}
              onDelete={(record) => openDelete({ kind: 'drama', record })}
              onDetail={(record) => void openDetail(record)}
              onEdit={openDramaEditor}
              onIncludeDeleted={setIncludeDeletedDramas}
              onPage={(page, pageSize) => void loadDramas(page, pageSize)}
              onRetry={() => void loadDramas(dramas.page, dramas.pageSize)}
              submitting={submitting}
            />
          ),
        },
        {
          key: 'categories',
          label: '分类',
          children: (
            <TaxonomyList
              canManage={canUpdate}
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
          key: 'tags',
          label: '标签',
          children: (
            <TaxonomyList
              canManage={canUpdate}
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
        {
          key: 'portability',
          label: '导入导出',
          children: (
            <PortabilityPanel
              canCreate={canCreate}
              data={imports}
              error={importError}
              exporting={submitting}
              loading={importLoading}
              onCreate={() => setImportOpen(true)}
              onDetail={(job) => void openImportDetail(job)}
              onExport={(format) => void exportContent(format)}
              onPage={(page, pageSize) => void loadImports(page, pageSize)}
              onRetry={() => void loadImports(imports.page, imports.pageSize)}
              onStatus={setImportStatus}
              status={importStatus}
            />
          ),
        },
      ]} />

      <Drawer
        destroyOnHidden
        loading={detailLoading}
        onClose={closeDetail}
        open={Boolean(selected)}
        title="短剧详情"
        width={900}
      >
        {detailError ? (
          <RetryAlert message={detailError} onRetry={() => selected && void openDetail(selected)} />
        ) : selected ? (
          <DramaDetail
            canUpdate={canUpdate}
            onAddEpisode={() => openEpisodeEditor(selected)}
            onBatchEpisodes={canUploadEpisode ? () => setBatchDrama(selected) : undefined}
            onEditEpisode={(episode) => openEpisodeEditor(selected, episode)}
            record={selected}
          />
        ) : null}
      </Drawer>

      <Drawer
        destroyOnHidden
        loading={importDetailLoading}
        onClose={closeImportDetail}
        open={Boolean(selectedImport)}
        title="导入任务详情"
        width={800}
      >
        {importDetailError ? (
          <RetryAlert
            message={importDetailError}
            onRetry={() => selectedImport && void openImportDetail(selectedImport, selectedImport.page)}
          />
        ) : selectedImport ? (
          <ImportDetailView
            detail={selectedImport}
            loading={importDetailLoading}
            onPage={(page) => void openImportDetail(selectedImport, page)}
            onRefresh={() => {
              void openImportDetail(selectedImport, selectedImport.page);
              void loadImports(imports.page, imports.pageSize);
            }}
          />
        ) : null}
      </Drawer>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={closeDramaEditor}
        open={Boolean(dramaEditor)}
        title={dramaEditor === 'create' ? '创建短剧草稿' : '编辑短剧'}
        width={780}
      >
        <Form form={dramaForm} layout="vertical" onFinish={(values) => void saveDrama(values)} preserve={false}>
          <Alert className="page-alert" message="新建短剧固定使用 S3 上传来源，不支持外链或同步导入来源。" showIcon type="info" />
          <Form.Item label="短剧 Code" name="code" rules={[
            { max: 128, min: 2, required: true },
            { pattern: /^[a-z0-9][a-z0-9_-]{1,127}$/, message: '仅支持小写字母、数字、_、-' },
          ]}><Input maxLength={128} /></Form.Item>
          <Form.Item label="封面 Media Asset ID（可选）">
            <Space.Compact block>
              <Form.Item name="coverFileId" noStyle>
                <Input maxLength={36} placeholder="本代理商可用、image、ready 的 UUID" />
              </Form.Item>
              {canCreate ? <Button htmlType="button" onClick={() => setUploadTarget('cover')}>上传图片</Button> : null}
            </Space.Compact>
          </Form.Item>
          <Form.Item label="分类" name="categoryId">
            <Select allowClear options={taxonomyOptions(categoryOptions)} placeholder="可选代理商分类或公共分类" />
          </Form.Item>
          <Form.Item label="标签" name="tagIds">
            <Select mode="multiple" options={taxonomyOptions(tagOptions)} placeholder="最多 50 个代理商或公共标签" />
          </Form.Item>
          <ScheduleFields />
          <TranslationFields kind="drama" />
          <Button
            block
            htmlType="submit"
            loading={submitting === (dramaEditor === 'create' ? 'drama:create' : `drama:${(dramaEditor as DramaRecord | undefined)?.id}`)}
            type="primary"
          >保存短剧</Button>
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
          <Form.Item extra="必填；保存时验证为当前代理商可用的 ready 视频。" label="正片 Media Asset ID" required>
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
          <Button
            block
            htmlType="submit"
            loading={Boolean(episodeEditor && submitting === (episodeEditor.episode
              ? `episode:${episodeEditor.episode.id}`
              : `episode:create:${episodeEditor.drama.id}`))}
            type="primary"
          >保存剧集</Button>
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
          <Button block htmlType="submit" loading={Boolean(taxonomyEditor && submitting === (taxonomyEditor.record
            ? `${taxonomyEditor.type}:${taxonomyEditor.record.id}`
            : `${taxonomyEditor.type}:create`))} type="primary">
            保存{taxonomyName(taxonomyEditor?.type ?? 'categories')}
          </Button>
        </Form>
      </Modal>

      <Modal destroyOnHidden footer={null} onCancel={closeDelete} open={Boolean(deleteTarget)} title="确认软删除">
        <Alert className="page-alert" message={deleteTarget?.kind === 'drama'
          ? '发布中或审核中的短剧不能删除。短剧软删除后可在 30 天恢复期内恢复。'
          : '公共分类/标签只读；代理商自有项被短剧引用时不能删除。'} showIcon type="warning" />
        <Form form={deleteForm} layout="vertical" onFinish={(values) => void deleteContent(values)} preserve={false}>
          <Form.Item label="删除原因" name="reason" rules={[{ max: 2000, required: true, whitespace: true }]}>
            <Input.TextArea maxLength={2000} rows={3} showCount />
          </Form.Item>
          <Form.Item name="confirmed" rules={[{ validator: confirmDelete }]} valuePropName="checked">
            <Checkbox>我确认软删除当前内容</Checkbox>
          </Form.Item>
          <Button block danger htmlType="submit" loading={Boolean(deleteTarget
            && submitting === `delete:${deleteTarget.kind}:${deleteTarget.record.id}`)} type="primary">
            确认软删除
          </Button>
        </Form>
      </Modal>

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => {
          if (submitting !== 'import:create') {
            setImportOpen(false);
            setImportFile(undefined);
          }
        }}
        open={importOpen}
        title="创建异步导入任务"
        width={620}
      >
        <Alert
          className="page-alert"
          description="浏览器只读取纯文本并提交给后端 worker；不会在 localStorage 保存文件内容。单文件硬限制 1 MiB。"
          message="JSON/CSV 安全导入"
          showIcon
          type="info"
        />
        <Form layout="vertical">
          <Form.Item label="格式">
            <Select<ImportFormat>
              onChange={(value) => { setImportFormat(value); setImportFile(undefined); }}
              options={[{ label: 'JSON', value: 'json' }, { label: 'CSV', value: 'csv' }]}
              value={importFormat}
            />
          </Form.Item>
          <Form.Item label="纯文本文件">
            <Input
              accept={importFormat === 'json' ? 'application/json,.json' : 'text/csv,.csv'}
              disabled={submitting === 'import:create'}
              onChange={(event) => setImportFile(event.target.files?.[0])}
              type="file"
            />
          </Form.Item>
          {importFile ? <Typography.Text>已选择：{importFile.name}（{formatContentBytes(importFile.size)}）</Typography.Text> : null}
          <Button block disabled={!importFile} loading={submitting === 'import:create'} onClick={() => void createImport()} type="primary">
            提交异步导入
          </Button>
        </Form>
      </Modal>

      <TenantMediaUploadModal
        kind={uploadTarget === 'cover' ? 'image' : 'video'}
        onCancel={() => setUploadTarget(undefined)}
        onReady={(mediaId, durationSeconds) => {
          if (uploadTarget === 'cover') dramaForm.setFieldValue('coverFileId', mediaId);
          else if (uploadTarget === 'episode-main') episodeForm.setFieldsValue({ mediaAssetId: mediaId, durationSeconds });
          else episodeForm.setFieldValue('previewMediaAssetId', mediaId);
          setUploadTarget(undefined);
          messageApi.success('文件已上传并经服务端验证为 ready，Media Asset ID 已填入表单');
        }}
        open={Boolean(uploadTarget)}
        purpose={uploadTarget}
      />
      {batchDrama && <BatchEpisodeUploadModal scope="tenant" dramaId={batchDrama.id} onClose={() => {
        setBatchDrama(undefined);
        void loadDramas(dramas.page, dramas.pageSize);
        void openDetail(batchDrama);
      }} />}
    </>
  );
}

function DramaList({
  canCreate,
  canSubmitReview,
  canUpdate,
  data,
  error,
  includeDeleted,
  loading,
  onAction,
  onCreate,
  onDelete,
  onDetail,
  onEdit,
  onIncludeDeleted,
  onPage,
  onRetry,
  submitting,
}: {
  canCreate: boolean;
  canSubmitReview: boolean;
  canUpdate: boolean;
  data: PageResponse<DramaRecord>;
  error?: string;
  includeDeleted: boolean;
  loading: boolean;
  onAction(record: DramaRecord, action: 'restore' | 'publish' | 'unpublish' | 'withdraw'): void;
  onCreate(): void;
  onDelete(record: DramaRecord): void;
  onDetail(record: DramaRecord): void;
  onEdit(record: DramaRecord): void;
  onIncludeDeleted(value: boolean): void;
  onPage(page: number, pageSize: number): void;
  onRetry(): void;
  submitting?: string;
}) {
  return (
    <>
      <div className="page-heading">
        <Space wrap>
          <Space>
            <Switch checked={includeDeleted} onChange={onIncludeDeleted} />
            <Typography.Text>查看已删除</Typography.Text>
          </Space>
          <Button loading={loading} onClick={onRetry}>刷新</Button>
        </Space>
        {canCreate ? <Button onClick={onCreate} type="primary">创建短剧</Button> : null}
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
          { dataIndex: 'status', title: '状态', width: 120, render: (value: DramaStatus, record) => (
            <Space direction="vertical" size={2}>
              <DramaStatusTag status={value} />
              {record.deletedAt ? <Tag color="red">已软删除</Tag> : null}
            </Space>
          ) },
          { dataIndex: 'totalEpisodes', title: '集数', width: 70 },
          { dataIndex: 'sourceType', title: '来源', width: 110, render: sourceTypeLabel },
          { key: 'languages', title: '语言', width: 160, render: (_, record) => record.translations.map((item) => <Tag key={item.locale}>{item.locale}</Tag>) },
          { key: 'schedule', title: '发布时间', width: 190, render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Typography.Text>{formatDateTime(record.releaseAt)}</Typography.Text>
              <Typography.Text type="secondary">下架：{formatDateTime(record.unpublishAt)}</Typography.Text>
            </Space>
          ) },
          { dataIndex: 'version', title: '版本', width: 70 },
          { key: 'actions', title: '操作', width: 330, render: (_, record) => {
            const editable = isTenantDramaEditable(record);
            return (
              <Space wrap>
                <Button size="small" onClick={() => onDetail(record)}>详情</Button>
                {canUpdate && !record.deletedAt ? <DramaRankingButton dramaId={record.id} /> : null}
                {canUpdate && editable ? <Button size="small" onClick={() => onEdit(record)}>编辑</Button> : null}
                {canUpdate && editable ? (
                  <Popconfirm description="由本代理商自行确认内容可发布，无需总部审核。封面及剧集须已就绪。" onConfirm={() => onAction(record, 'publish')} title="确认上架？">
                    <Button loading={submitting === `publish:${record.id}`} size="small" type="primary">确认上架</Button>
                  </Popconfirm>
                ) : null}
                {canUpdate && !record.deletedAt && ['published', 'approved'].includes(record.status) ? (
                  <Popconfirm description="下架后保留已购权益，并取消未执行的定时任务。" onConfirm={() => onAction(record, 'unpublish')} title="确认下架？">
                    <Button loading={submitting === `unpublish:${record.id}`} size="small">下架</Button>
                  </Popconfirm>
                ) : null}
                {canSubmitReview && !record.deletedAt && record.status === 'pending_review' ? (
                  <Popconfirm onConfirm={() => onAction(record, 'withdraw')} title="确认撤回审核并恢复草稿？">
                    <Button loading={submitting === `withdraw:${record.id}`} size="small">撤回旧审核</Button>
                  </Popconfirm>
                ) : null}
                {canUpdate && !record.deletedAt && ['draft', 'rejected', 'unpublished'].includes(record.status)
                  ? <Button danger size="small" onClick={() => onDelete(record)}>软删除</Button> : null}
                {canUpdate && isDramaRestorable(record) ? (
                  <Popconfirm onConfirm={() => onAction(record, 'restore')} title="确认在 30 天恢复期内恢复？">
                    <Button loading={submitting === `restore:${record.id}`} size="small">恢复</Button>
                  </Popconfirm>
                ) : null}
              </Space>
            );
          } },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description={includeDeleted ? '暂无已删除短剧' : '暂无短剧'} /> }}
        pagination={{
          current: data.page,
          onChange: onPage,
          pageSize: data.pageSize,
          pageSizeOptions: [20, 50, 100],
          showSizeChanger: true,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 1280 }}
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
            <Typography.Text>包含已删除代理商项</Typography.Text>
          </Space>
          <Button loading={loading} onClick={onRetry}>刷新</Button>
        </Space>
        {canManage ? <Button onClick={onCreate} type="primary">创建{taxonomyName(type)}</Button> : null}
      </div>
      <Alert className="page-alert" message="公共分类和标签可用于短剧，但只能由总后台维护；代理商只能修改自己的项目。" showIcon type="info" />
      {error ? <RetryAlert message={error} onRetry={onRetry} /> : null}
      <Table<TaxonomyRecord>
        columns={[
          { key: 'name', title: '名称', render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{translationValue(record.translations, 'name') || record.code}</Typography.Text>
              <Typography.Text className="secondary-id" type="secondary">{record.code} · {record.id}</Typography.Text>
            </Space>
          ) },
          { dataIndex: 'ownerType', title: '归属', width: 90, render: (value) => value === 'platform' ? <Tag color="blue">公共</Tag> : <Tag>代理商</Tag> },
          { dataIndex: 'status', title: '状态', width: 100, render: (value, record) => (
            <Space direction="vertical" size={2}>
              {value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
              {record.deletedAt ? <Tag color="red">已删除</Tag> : null}
            </Space>
          ) },
          ...(type === 'categories' ? [{ dataIndex: 'sortOrder' as const, title: '排序', width: 80 }] : []),
          { key: 'languages', title: '语言', render: (_, record) => record.translations.map((item) => <Tag key={item.locale}>{item.locale}</Tag>) },
          { dataIndex: 'version', title: '版本', width: 70 },
          { key: 'actions', title: '操作', width: 170, render: (_, record) => {
            if (record.ownerType === 'platform') return <Typography.Text type="secondary">公共只读</Typography.Text>;
            if (!canManage) return <Typography.Text type="secondary">只读</Typography.Text>;
            if (record.deletedAt) return (
              <Popconfirm onConfirm={() => onRestore(record)} title="确认恢复？恢复期由服务端最终校验。">
                <Button loading={submitting === `restore:${type}:${record.id}`} size="small">恢复</Button>
              </Popconfirm>
            );
            return (
              <Space>
                <Button size="small" onClick={() => onEdit(record)}>编辑</Button>
                <Button danger size="small" onClick={() => onDelete(record)}>删除</Button>
              </Space>
            );
          } },
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

function PortabilityPanel({
  canCreate,
  data,
  error,
  exporting,
  loading,
  onCreate,
  onDetail,
  onExport,
  onPage,
  onRetry,
  onStatus,
  status,
}: {
  canCreate: boolean;
  data: PageResponse<ImportJob>;
  error?: string;
  exporting?: string;
  loading: boolean;
  onCreate(): void;
  onDetail(job: ImportJob): void;
  onExport(format: ImportFormat): void;
  onPage(page: number, pageSize: number): void;
  onRetry(): void;
  onStatus(value: ImportJob['status'] | undefined): void;
  status?: ImportJob['status'];
}) {
  return (
    <>
      <div className="page-heading">
        <Space wrap>
          <Select
            allowClear
            onChange={onStatus}
            options={importStatusOptions}
            placeholder="全部导入状态"
            style={{ width: 170 }}
            value={status}
          />
          <Button loading={loading} onClick={onRetry}>刷新任务</Button>
          <Button loading={exporting === 'export:json'} onClick={() => onExport('json')}>导出 JSON</Button>
          <Button loading={exporting === 'export:csv'} onClick={() => onExport('csv')}>导出 CSV</Button>
        </Space>
        {canCreate ? <Button onClick={onCreate} type="primary">导入 JSON/CSV</Button> : null}
      </div>
      <Alert
        className="page-alert"
        description="导入由后端 worker 异步校验并逐行记录错误；导出内容仅用于本次 Blob 下载，不会写入 localStorage。"
        message="导入导出不会绕过媒体、分类、标签和租户归属校验"
        showIcon
        type="info"
      />
      {error ? <RetryAlert message={error} onRetry={onRetry} /> : null}
      <Table<ImportJob>
        columns={[
          { dataIndex: 'id', title: '任务 ID', render: (value, job) => <Button className="table-link-button" onClick={() => onDetail(job)} type="link">{value}</Button> },
          { dataIndex: 'format', title: '格式', width: 80, render: (value) => String(value).toUpperCase() },
          { dataIndex: 'status', title: '状态', width: 120, render: (value: ImportJob['status']) => <ImportStatusTag status={value} /> },
          { dataIndex: 'createdAt', title: '创建时间', width: 180, render: formatDateTime },
          { dataIndex: 'validatedAt', title: '校验时间', width: 180, render: formatDateTime },
          { dataIndex: 'version', title: '版本', width: 70 },
          { key: 'action', title: '操作', width: 80, render: (_, job) => <Button size="small" onClick={() => onDetail(job)}>详情</Button> },
        ]}
        dataSource={data.items}
        loading={loading}
        locale={{ emptyText: <Empty description="暂无导入任务" /> }}
        pagination={{
          current: data.page,
          onChange: onPage,
          pageSize: data.pageSize,
          pageSizeOptions: [20, 50, 100],
          showSizeChanger: true,
          total: data.total,
        }}
        rowKey="id"
        scroll={{ x: 950 }}
      />
    </>
  );
}

function DramaDetail({
  canUpdate,
  onAddEpisode,
  onBatchEpisodes,
  onEditEpisode,
  record,
}: {
  canUpdate: boolean;
  onAddEpisode(): void;
  onBatchEpisodes?(): void;
  onEditEpisode(episode: EpisodeRecord): void;
  record: DramaRecord;
}) {
  const editable = canUpdate && isTenantDramaEditable(record);
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="短剧 ID"><Typography.Text copyable>{record.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="Code">{record.code}</Descriptions.Item>
        <Descriptions.Item label="状态"><DramaStatusTag status={record.status} /> {record.deletedAt ? <Tag color="red">已软删除</Tag> : null}</Descriptions.Item>
        <Descriptions.Item label="来源">{sourceTypeLabel(record.sourceType)}</Descriptions.Item>
        <Descriptions.Item label="封面 Media Asset ID">{record.coverFileId ? <Typography.Text copyable>{record.coverFileId}</Typography.Text> : '未设置'}</Descriptions.Item>
        <Descriptions.Item label="分类 ID">{record.categoryId ?? '未设置'}</Descriptions.Item>
        <Descriptions.Item label="标签 ID">{record.tagIds.length ? record.tagIds.map((id) => <Tag key={id}>{id}</Tag>) : '未设置'}</Descriptions.Item>
        <Descriptions.Item label="发布时间">{formatDateTime(record.releaseAt)}</Descriptions.Item>
        <Descriptions.Item label="下架时间">{formatDateTime(record.unpublishAt)}</Descriptions.Item>
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
        {!editable ? <Alert className="page-alert" message="仅草稿或驳回状态允许编辑剧集；审核中、已发布、已下架或已删除状态只读。" showIcon type="info" /> : null}
        <Alert className="page-alert" message="媒体列显示绑定状态，不伪造实时转码状态；创建、更新和提审时服务端会重新验证正片与独立试看均为本代理商可用的 ready 视频。" showIcon type="info" />
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
            { key: 'action', title: '操作', width: 90, render: (_, episode) => editable
              ? <Button size="small" onClick={() => onEditEpisode(episode)}>编辑</Button>
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

function ImportDetailView({
  detail,
  loading,
  onPage,
  onRefresh,
}: {
  detail: ImportDetail;
  loading: boolean;
  onPage(page: number): void;
  onRefresh(): void;
}) {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Descriptions bordered column={1} size="small">
        <Descriptions.Item label="任务 ID"><Typography.Text copyable>{detail.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="格式">{detail.format.toUpperCase()}</Descriptions.Item>
        <Descriptions.Item label="状态"><ImportStatusTag status={detail.status} /></Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatDateTime(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="校验时间">{formatDateTime(detail.validatedAt)}</Descriptions.Item>
        <Descriptions.Item label="完成时间">{formatDateTime(detail.completedAt)}</Descriptions.Item>
        <Descriptions.Item label="摘要"><Typography.Text>{safeImportErrors(detail.summary)}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="版本">{detail.version}</Descriptions.Item>
      </Descriptions>
      <Button loading={loading} onClick={onRefresh}>刷新异步状态</Button>
      <Table<ImportRow>
        columns={[
          { dataIndex: 'rowNumber', title: '行', width: 70 },
          { dataIndex: 'status', title: '状态', width: 100 },
          { dataIndex: 'errors', title: '安全错误', render: (value) => <Typography.Text type={value ? 'danger' : undefined}>{safeImportErrors(value)}</Typography.Text> },
          { dataIndex: 'importedDramaId', title: '已创建短剧 ID', render: (value?: string) => value ? <Typography.Text copyable>{value}</Typography.Text> : '—' },
        ]}
        dataSource={detail.rows}
        locale={{ emptyText: <Empty description="暂无逐行结果，任务可能仍在处理" /> }}
        pagination={false}
        rowKey="rowNumber"
        size="small"
      />
      <Space>
        <Button disabled={detail.page <= 1 || loading} onClick={() => onPage(detail.page - 1)}>上一页</Button>
        <Typography.Text>第 {detail.page} 页</Typography.Text>
        <Button
          disabled={detail.rows.length < detail.pageSize || loading}
          onClick={() => onPage(detail.page + 1)}
        >下一页</Button>
      </Space>
    </Space>
  );
}

function ScheduleFields() {
  return (
    <>
      <Alert className="page-alert" message="发布时间和下架时间由服务端按标准 ISO 时区处理；设置下架时间时必须先设置更早的发布时间。" showIcon type="info" />
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

function TenantMediaUploadModal({
  kind,
  onCancel,
  onReady,
  open,
  purpose,
}: {
  kind: 'image' | 'video';
  onCancel(): void;
  onReady(mediaId: string, durationSeconds?: number): void;
  open: boolean;
  purpose?: UploadTarget;
}) {
  const { principal, request } = useAuth();
  const [providerId, setProviderId] = useState('');
  const [providers, setProviders] = useState<TenantStorageProvider[]>([]);
  const [file, setFile] = useState<File>();
  const [stage, setStage] = useState<string>();
  const [hashProgress, setHashProgress] = useState(0);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const canReadStorage = principal?.permissions.includes('tenant.storage.read') ?? false;

  useEffect(() => {
    if (!open) return;
    setProviderId('');
    setProviders([]);
    setFile(undefined);
    setStage(undefined);
    setHashProgress(0);
    setError(undefined);
    if (!canReadStorage) return;
    let active = true;
    void request<PageResponse<TenantStorageProvider>>(`${STORAGE_API}?page=1&pageSize=100`)
      .then((result) => {
        if (!active) return;
        const available = result.items.filter((provider) => provider.status === 'active' && provider.ownerType === 'tenant');
        setProviders(available);
        setProviderId(available[0]?.id ?? '');
      })
      .catch(() => {
        if (active) setError('可用对象存储加载失败，可刷新后重试或输入管理员提供的 Provider UUID');
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
      setError(!file ? '请选择需要上传的文件' : '请选择有效的 S3 Provider');
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
      setStage('正在按 4 MiB 分块计算 SHA-256，不会一次载入整个大文件');
      const checksumSha256 = await sha256Blob(file, {
        onProgress: (ratio) => setHashProgress(Math.round(ratio * 100)),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setStage('正在申请一次性 S3 直传地址');
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
      setStage('正在直传对象存储；完成核验前不会把 Media ID 视为 ready');
      const uploadResponse = await fetch(intent.uploadUrl, {
        body: file,
        credentials: 'omit',
        headers: contentUploadHeaders(intent.requiredHeaders, file),
        method: 'PUT',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!uploadResponse.ok) throw new Error(`对象存储直传失败（HTTP ${uploadResponse.status}）`);
      setStage('正在由服务端 HEAD 核验大小、类型和 SHA-256');
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
      title={kind === 'image' ? '上传封面图片' : purpose === 'episode-preview' ? '单独上传试看短片' : '单独上传正片视频'}
      width={640}
    >
      <Alert
        className="page-alert"
        message="本地分块校验 → S3 条件直传 → 服务端 HEAD 核验 → ready。不会使用外链，也不会跳过完成核验。"
        showIcon
        type="info"
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>可用对象存储</Typography.Text>
          {canReadStorage ? (
            <Select
              disabled={Boolean(stage)}
              onChange={setProviderId}
              options={providers.map((provider) => ({
                label: `${provider.label} · ${provider.ownerType === 'platform' ? '公共只读' : '代理商私有'}`,
                value: provider.id,
              }))}
              placeholder="请选择已启用的 S3 Provider"
              style={{ width: '100%' }}
              value={providerId || undefined}
            />
          ) : (
            <Input
              disabled={Boolean(stage)}
              maxLength={36}
              onChange={(event) => setProviderId(event.target.value)}
              placeholder="当前账号无存储读取权限，请输入管理员提供的 Provider UUID"
              value={providerId}
            />
          )}
        </div>
        <div>
          <Typography.Text strong>{kind === 'image' ? '图片文件' : '视频文件'}</Typography.Text>
          <Input
            accept={kind === 'image'
              ? 'image/avif,image/jpeg,image/png,image/webp'
              : 'video/mp4,video/quicktime,video/webm'}
            disabled={Boolean(stage)}
            onChange={(event) => setFile(event.target.files?.[0])}
            type="file"
          />
          <Typography.Text type="secondary">
            {kind === 'image' ? 'AVIF/JPEG/PNG/WebP，最大 25 MiB' : 'MP4/MOV/WebM，最大 2 GiB'}
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
        <Button block disabled={Boolean(stage) || (canReadStorage && !providers.length)} onClick={() => void upload()} type="primary">
          开始安全上传
        </Button>
        {stage ? <Button block danger onClick={cancel}>取消上传</Button> : null}
      </Space>
    </Modal>
  );
}

const importStatusOptions = [
  { label: '已上传', value: 'uploaded' },
  { label: '校验中', value: 'validating' },
  { label: '待导入', value: 'ready' },
  { label: '导入中', value: 'importing' },
  { label: '已完成', value: 'completed' },
  { label: '失败', value: 'failed' },
  { label: '已取消', value: 'cancelled' },
] satisfies Array<{ label: string; value: ImportJob['status'] }>;

function RetryAlert({ message: text, onRetry }: { message: string; onRetry(): void }) {
  return <Alert action={<Button size="small" onClick={onRetry}>重试</Button>} className="page-alert" message={text} showIcon type="error" />;
}

function DramaStatusTag({ status }: { status: DramaStatus }) {
  const option: Record<DramaStatus, { color?: string; text: string }> = {
    approved: { color: 'cyan', text: '待定时上架' },
    draft: { text: '草稿' },
    pending_review: { color: 'processing', text: '旧审核待撤回' },
    published: { color: 'green', text: '已发布' },
    rejected: { color: 'red', text: '已驳回' },
    unpublished: { color: 'orange', text: '已下架' },
  };
  return <Tag color={option[status].color}>{option[status].text}</Tag>;
}

function ImportStatusTag({ status }: { status: ImportJob['status'] }) {
  const option = {
    cancelled: { color: undefined, text: '已取消' },
    completed: { color: 'green', text: '已完成' },
    failed: { color: 'red', text: '失败' },
    importing: { color: 'processing', text: '导入中' },
    ready: { color: 'cyan', text: '待导入' },
    uploaded: { color: 'blue', text: '已上传' },
    validating: { color: 'processing', text: '校验中' },
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
    label: `${translationValue(record.translations, 'name') ?? record.code} · ${record.code}${record.ownerType === 'platform' ? ' · 公共' : ''}`,
    value: record.id,
  }));
}

function taxonomyName(type: TaxonomyType): string {
  return type === 'categories' ? '分类' : '标签';
}

function sourceTypeLabel(value: string): string {
  if (value === 'upload') return 'S3 上传';
  if (value === 'import') return '历史批量导入';
  return '历史外链（只读）';
}

function isDramaRestorable(record: DramaRecord, now = Date.now()): boolean {
  if (!record.deletedAt || !record.restoreUntil) return false;
  const deadline = Date.parse(record.restoreUntil);
  return Number.isFinite(deadline) && deadline > now;
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
  if (reason.status === 403) return '当前账号没有执行该操作的权限，或代理商已过期进入只读状态';
  if (reason.status === 409) return '数据版本或状态已变化，页面将刷新，请重新操作';
  if ([400, 404].includes(reason.status) && reason.message) return reason.message;
  return fallback;
}

function isConflict(reason: unknown): boolean {
  return isContentVersionConflict(reason);
}

function localError(reason: unknown, fallback = '输入内容无效'): string {
  return reason instanceof Error ? reason.message : fallback;
}

function uploadError(reason: unknown): string {
  if (reason instanceof ApiError) return contentError(reason, '媒体上传接口调用失败');
  return reason instanceof Error ? reason.message : '媒体上传失败';
}
