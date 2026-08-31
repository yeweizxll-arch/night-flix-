export type ContentLocale = 'zh-CN' | 'zh-TW' | 'en-US' | 'fr-FR' | 'ja-JP' | 'ko-KR';
export type DramaStatus = 'approved' | 'draft' | 'published' | 'rejected' | 'unpublished';

export const contentLocaleOptions: Array<{ label: string; value: ContentLocale }> = [
  { label: '简体中文', value: 'zh-CN' },
  { label: '繁體中文', value: 'zh-TW' },
  { label: 'English', value: 'en-US' },
  { label: 'Français', value: 'fr-FR' },
  { label: '日本語', value: 'ja-JP' },
  { label: '한국어', value: 'ko-KR' },
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function optionalCanonicalIso(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error('时间必须是带毫秒和时区的标准 ISO 格式，例如 2026-08-22T12:00:00.000Z');
  }
  return normalized;
}

export function keywordList(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (result.length > 50 || result.some((item) => item.length > 100)) {
    throw new Error('每种语言最多 50 个关键词，每个不超过 100 字符');
  }
  return [...new Set(result)];
}

export function assertUniqueLocales(translations: Array<{ locale?: string }>): void {
  const locales = translations.map((translation) => translation.locale).filter(Boolean);
  if (new Set(locales).size !== locales.length) throw new Error('同一种语言只能配置一次');
}

export function isDramaEditable(status: DramaStatus, deletedAt?: string): boolean {
  return !deletedAt && ['draft', 'unpublished', 'rejected'].includes(status);
}

export function isDramaPublishable(status: DramaStatus, deletedAt?: string): boolean {
  return !deletedAt && ['draft', 'unpublished', 'rejected'].includes(status);
}

export function isDramaUnpublishable(status: DramaStatus, deletedAt?: string): boolean {
  return !deletedAt && ['approved', 'published'].includes(status);
}

export function isDramaRestorable(
  deletedAt: string | undefined,
  restoreUntil: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!deletedAt || !restoreUntil) return false;
  const deadline = new Date(restoreUntil).getTime();
  return Number.isFinite(deadline) && deadline > nowMs;
}
