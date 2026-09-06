export function videoDurationSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) {
    throw new Error('无法识别有效视频时长，请检查文件或转换为标准 MP4 后重试');
  }
  return Math.ceil(duration);
}

/** Read this File's metadata, without uploading it or loading its entire body. */
export function readVideoDuration(file: File, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (error?: Error, duration?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(duration!);
    };
    const abort = () => finish(new DOMException('已暂停', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('读取视频时长超时，请检查文件格式')), 30000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      try { finish(undefined, videoDurationSeconds(video.duration)); }
      catch (error) { finish(error as Error); }
    };
    video.onerror = () => finish(new Error('浏览器无法读取这个视频，请转换为标准 MP4 后重试'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else video.src = url;
  });
}
