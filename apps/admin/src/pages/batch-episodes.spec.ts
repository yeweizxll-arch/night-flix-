import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { prepareEpisodeFiles, runEpisodeBatch, validateEpisodeBatch, type ContentRequest } from './batch-episodes';
import { readVideoDuration, videoDurationSeconds } from './video-duration';

const file = (name: string) => new File(['test video'], name, { type: 'video/mp4' });
const defaults = { apiBase: '/content', dramaId: 'drama', locale: 'zh-CN', providerId: 'store', changed: vi.fn() };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('batch episode creation', () => {
  it('sorts naturally, starts after existing episodes, and rejects duplicates/limits', () => {
    const rows = prepareEpisodeFiles([file('第10集.mp4'), file('第2集.mp4'), file('第1集.mp4')], 5);
    expect(rows.map(row => row.file.name)).toEqual(['第1集.mp4', '第2集.mp4', '第10集.mp4']);
    expect(rows.map(row => row.episodeNo)).toEqual([5, 6, 7]);
    rows[1]!.episodeNo = 5;
    expect(() => validateEpisodeBatch(rows)).toThrow('重复');
    expect(() => prepareEpisodeFiles([file('1.mp4'), file('2.mp4')], 1000)).toThrow('1000');
  });

  it('uses each actual duration and the newest drama version, without a fake preview', async () => {
    const rows = prepareEpisodeFiles([file('1.mp4'), file('2.mp4')], 1);
    const saves: Record<string, unknown>[] = [];
    const request: ContentRequest = vi.fn(async (_path, init) => {
      if (init?.method === 'POST') { saves.push(JSON.parse(init.body as string)); return {} as never; }
      return { version: saves.length + 7, episodes: [] } as never;
    });
    const upload = vi.fn(async f => f.name);
    await runEpisodeBatch(rows, { ...defaults, request, upload, readDuration: vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(17), signal: new AbortController().signal });
    expect(saves.map(save => [save.durationSeconds, save.expectedDramaVersion, save.previewSeconds])).toEqual([[3, 7, 0], [17, 8, 0]]);
    expect(rows.every(row => row.done)).toBe(true);
    await runEpisodeBatch(rows, { ...defaults, request, upload, signal: new AbortController().signal });
    expect(upload).toHaveBeenCalledTimes(2); expect(saves).toHaveLength(2);
  });

  it('retries an ambiguous committed save with the same key/body and no new upload', async () => {
    const rows = prepareEpisodeFiles([file('1.mp4')], 1);
    const attempts: RequestInit[] = [];
    const request: ContentRequest = vi.fn(async (_path, init) => {
      if (init?.method === 'POST') {
        attempts.push(init);
        if (attempts.length === 1) throw new TypeError('Network response lost');
        return {} as never;
      }
      return { version: 4, episodes: [] } as never;
    });
    const upload = vi.fn(async () => 'ready-media');
    const options = { ...defaults, request, upload, readDuration: vi.fn(async () => 7), signal: new AbortController().signal };
    await runEpisodeBatch(rows, options); expect(rows[0]?.done).toBeUndefined();
    await runEpisodeBatch(rows, options);
    expect(rows[0]?.done).toBe(true); expect(upload).toHaveBeenCalledTimes(1);
    expect(attempts[1]?.body).toBe(attempts[0]?.body);
    expect(attempts[1]?.headers).toEqual(attempts[0]?.headers);
  });

  it('retains successful files when another upload fails and never overwrites an existing episode', async () => {
    const rows = prepareEpisodeFiles([file('1.mp4'), file('2.mp4')], 1);
    const upload = vi.fn().mockRejectedValueOnce(new Error('upload failed')).mockResolvedValue('ready-media');
    const request: ContentRequest = vi.fn(async (_path, init) => init?.method === 'POST' ? {} as never : { version: 0, episodes: [] } as never);
    const options = { ...defaults, request, upload, readDuration: vi.fn(async () => 9), signal: new AbortController().signal };
    await runEpisodeBatch(rows, options);
    expect(rows[0]?.error).toBe('upload failed'); expect(rows[1]?.done).toBe(true);
    await runEpisodeBatch(rows, options); expect(upload).toHaveBeenCalledTimes(3);
    const duplicate = prepareEpisodeFiles([file('1.mp4')], 1);
    const duplicateRequest: ContentRequest = vi.fn(async () => ({ version: 3, episodes: [{ episodeNo: 1 }] }) as never);
    await runEpisodeBatch(duplicate, { ...options, request: duplicateRequest });
    expect(duplicate[0]?.error).toContain('已存在'); expect(duplicate[0]?.done).toBeUndefined();
  });

  it('refreshes version after a definite CAS rejection while reusing the uploaded media', async () => {
    const rows = prepareEpisodeFiles([file('1.mp4')], 1);
    let saves = 0;
    const request: ContentRequest = vi.fn(async (_path, init) => {
      if (init?.method === 'POST' && saves++ === 0) throw new ApiError('changed', 409);
      return { version: saves, episodes: [] } as never;
    });
    const upload = vi.fn(async () => 'ready-media');
    const options = { ...defaults, request, upload, readDuration: vi.fn(async () => 9), signal: new AbortController().signal };
    await runEpisodeBatch(rows, options); expect(rows[0]?.saveRequest).toBeUndefined();
    await runEpisodeBatch(rows, options); expect(rows[0]?.done).toBe(true); expect(upload).toHaveBeenCalledTimes(1);
  });

  it('pauses between upload and save and resumes without uploading the ready file again', async () => {
    const rows = prepareEpisodeFiles([file('1.mp4')], 1);
    const controller = new AbortController();
    const upload = vi.fn(async () => { controller.abort(); return 'ready-media'; });
    const request: ContentRequest = vi.fn(async () => ({ version: 1, episodes: [] }) as never);
    const options = { ...defaults, request, upload, readDuration: vi.fn(async () => 8) };
    await runEpisodeBatch(rows, { ...options, signal: controller.signal });
    expect(rows[0]?.mediaId).toBe('ready-media'); expect(request).not.toHaveBeenCalled();
    await runEpisodeBatch(rows, { ...options, signal: new AbortController().signal });
    expect(rows[0]?.done).toBe(true); expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('automatic video metadata', () => {
  it('uses a positive per-video duration; never falls back to 60', () => {
    expect(videoDurationSeconds(3.1)).toBe(4);
    for (const duration of [0, -1, NaN, Infinity, 86401]) expect(() => videoDurationSeconds(duration)).toThrow();
  });
  it('releases object URLs on success, decode failure and cancellation', async () => {
    let video: { duration: number; onloadedmetadata?: () => void; onerror?: () => void; load: () => void; removeAttribute: () => void };
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.stubGlobal('document', { createElement: () => (video = { duration: 12.4, load() {}, removeAttribute() {} }) });
    const success = readVideoDuration(file('1.mp4')); video!.onloadedmetadata!(); await expect(success).resolves.toBe(13);
    const failure = readVideoDuration(file('2.mp4')); video!.onerror!(); await expect(failure).rejects.toThrow('无法读取');
    const controller = new AbortController(); const cancel = readVideoDuration(file('3.mp4'), controller.signal); controller.abort();
    await expect(cancel).rejects.toMatchObject({ name: 'AbortError' }); expect(revoke).toHaveBeenCalledTimes(3);
  });
});
