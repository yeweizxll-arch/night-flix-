import { ApiError } from '../api/http';
import { contentFileExtension, contentUploadHeaders, validateContentUploadFile, validateContentUploadIntent, type ContentUploadIntent } from './content-upload-ui';
import { sha256Blob } from './file-sha256';
import { isUuid } from './platform-content-library-ui';
import { readVideoDuration } from './video-duration';

export type ContentRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export interface BatchEpisode {
  id: string;
  file: File;
  episodeNo: number;
  title: string;
  durationSeconds?: number;
  mediaId?: string;
  done?: boolean;
  stage?: string;
  error?: string;
  // Retain exactly the same body/key if a committed response was lost.
  saveRequest?: { key: string; body: string };
}

export function prepareEpisodeFiles(files: File[], start: number): BatchEpisode[] {
  if (!files.length || files.length > 1000 || !Number.isInteger(start) || start < 1 || start + files.length - 1 > 1000) {
    throw new Error('单部短剧最多 1000 集，请检查文件数量和起始集数');
  }
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })).map((file, index) => ({
    id: crypto.randomUUID(), file, episodeNo: start + index,
    title: file.name.replace(/\.[^.]+$/, '').trim().slice(0, 200) || `第 ${start + index} 集`,
  }));
}

export function validateEpisodeBatch(rows: BatchEpisode[]): void {
  const numbers = rows.map(row => row.episodeNo);
  if (new Set(numbers).size !== numbers.length) throw new Error('集数重复，请调整后再上传');
  if (rows.some(row => !Number.isInteger(row.episodeNo) || row.episodeNo < 1 || row.episodeNo > 1000 || !row.title.trim())) {
    throw new Error('请填写有效集数和标题');
  }
}

export async function uploadEpisodeFile(file: File, providerId: string, apiBase: string, request: ContentRequest,
  signal: AbortSignal, stage: (value: string) => void): Promise<string> {
  const invalid = validateContentUploadFile(file, 'video');
  if (invalid) throw new Error(invalid);
  const checksumSha256 = await sha256Blob(file, { signal, onProgress: ratio => stage(`校验文件 ${Math.round(ratio * 100)}%`) });
  signal.throwIfAborted();
  stage('申请上传');
  const intent = await request<ContentUploadIntent>(`${apiBase}/media/uploads`, {
    method: 'POST', signal, body: JSON.stringify({ checksumSha256, contentType: file.type,
      extension: contentFileExtension(file.name), kind: 'video', providerId, sizeBytes: file.size }),
  });
  validateContentUploadIntent(intent, file, isUuid);
  stage('上传视频');
  const response = await fetch(intent.uploadUrl, { method: 'PUT', body: file, credentials: 'omit', mode: 'cors',
    headers: contentUploadHeaders(intent.requiredHeaders, file), signal });
  if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}），可重试本集`);
  stage('核验文件');
  const completed = await request<{ id: string; status: string }>(`${apiBase}/media/uploads/${intent.id}/complete`, { method: 'POST', signal });
  if (completed.id !== intent.id || completed.status !== 'ready') throw new Error('文件尚未完成服务端核验');
  return completed.id;
}

/** Sequential writes preserve the existing drama-version CAS and bounded memory. */
export async function runEpisodeBatch(rows: BatchEpisode[], options: {
  apiBase: string; dramaId: string; locale: string; providerId: string;
  request: ContentRequest; signal: AbortSignal; changed(): void;
  readDuration?: typeof readVideoDuration; upload?: typeof uploadEpisodeFile;
}): Promise<void> {
  validateEpisodeBatch(rows);
  const { request, signal, apiBase, dramaId, locale, providerId, changed } = options;
  for (const row of rows) {
    if (signal.aborted) break;
    if (row.done) continue;
    row.error = undefined;
    const stage = (value: string) => { row.stage = value; changed(); };
    try {
      if (!row.durationSeconds) { stage('读取时长'); row.durationSeconds = await (options.readDuration ?? readVideoDuration)(row.file, signal); }
      if (!row.mediaId) row.mediaId = await (options.upload ?? uploadEpisodeFile)(row.file, providerId, apiBase, request, signal, stage);
      signal.throwIfAborted();
      if (!row.saveRequest) {
        const current = await request<{ version: number; episodes: { episodeNo: number }[] }>(`${apiBase}/dramas/${dramaId}`, { signal });
        if (current.episodes.some(episode => episode.episodeNo === row.episodeNo)) throw new Error(`第 ${row.episodeNo} 集已存在，请修改集数，不会覆盖原剧集`);
        row.saveRequest = { key: crypto.randomUUID(), body: JSON.stringify({ episodeNo: row.episodeNo,
          durationSeconds: row.durationSeconds, expectedDramaVersion: current.version, mediaAssetId: row.mediaId,
          previewSeconds: 0, translations: [{ locale, title: row.title.trim() }] }) };
      }
      stage('保存剧集');
      await request(`${apiBase}/dramas/${dramaId}/episodes`, { method: 'POST', signal,
        headers: { 'Idempotency-Key': row.saveRequest.key }, body: row.saveRequest.body });
      row.done = true;
      row.saveRequest = undefined;
      stage('已添加');
    } catch (error) {
      // A definitive rejection can be corrected; an ambiguous response must
      // reuse its exact idempotency key/body before processing another row.
      if (error instanceof ApiError && [400, 403, 404, 409, 422].includes(error.status)) row.saveRequest = undefined;
      row.error = signal.aborted ? '已暂停，可继续' : error instanceof Error ? error.message : '本集处理失败，可重试';
      stage(signal.aborted ? '已暂停' : '失败');
      if (row.saveRequest || signal.aborted) break;
    }
  }
}
