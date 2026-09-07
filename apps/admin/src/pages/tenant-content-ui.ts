export function isTenantDramaEditable(record: { status: string; deletedAt?: string }): boolean {
  return !record.deletedAt && ['draft', 'rejected', 'unpublished'].includes(record.status);
}

export const MAX_IMPORT_BYTES = 1024 * 1024;

export async function readContentImportFile(file: File): Promise<string> {
  if (file.size < 2 || file.size > MAX_IMPORT_BYTES) {
    throw new Error('导入文件必须为纯文本且不超过 1 MiB');
  }
  const payload = await file.text();
  if (new Blob([payload]).size < 2 || new Blob([payload]).size > MAX_IMPORT_BYTES) {
    throw new Error('导入内容必须为 UTF-8 纯文本且不超过 1 MiB');
  }
  if (payload.includes('\0')) throw new Error('导入内容不能包含 NUL 字符');
  return payload;
}

export function safeExportFilename(value: string, format: 'csv' | 'json'): string {
  const basename = value.split(/[\\/]/).at(-1)?.trim() ?? '';
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return safe && safe.toLowerCase().endsWith(`.${format}`)
    ? safe
    : `content-export.${format}`;
}

export function safeImportErrors(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
      .map((item) => importErrorLabels[item] ?? item.slice(0, 500)).join('；') || '—';
  }
  if (typeof value === 'string') return value.slice(0, 1000);
  if (value && typeof value === 'object') {
    const summary = value as Record<string, unknown>;
    if (summary.code) return '导入处理失败，请稍后重试；持续失败时请提供任务编号联系技术支持。';
    return Object.entries({ importedRows: '成功部数', errorRows: '失败行数', rowCount: '提交部数', episodeCount: '剧集数' })
      .filter(([key]) => Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0)
      .map(([key, label]) => `${label}：${summary[key]}`).join('；') || '暂无处理结果';
  }
  return '—';
}

const importErrorLabels: Record<string, string> = {
  'Drama code already exists': '短剧编号已存在，请更换编号后重试',
  'Cover must be a ready tenant S3 image': '封面不可用，请选择本代理商已上传完成的图片',
  'Category is unavailable': '分类不可用，请重新选择',
  'One or more tags are unavailable': '部分标签不可用，请重新选择',
  'Episode numbers must be unique': '集数重复，请检查后重试',
  'Episodes must use ready tenant S3 video': '部分剧集视频不可用，请先完成上传',
  'Preview media must be a separate ready tenant S3 video': '试看视频必须已上传完成且与正片不同',
  'Tenant is unavailable': '代理商服务暂不可用，请联系技术支持',
};
