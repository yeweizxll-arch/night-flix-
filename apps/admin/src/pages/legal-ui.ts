import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
export const LEGAL_LOCALES = SUPPORTED_APP_LOCALES;
export const LEGAL_DOCUMENT_TYPES = ['privacy', 'terms', 'refund', 'community'] as const;

export type LegalLocale = (typeof LEGAL_LOCALES)[number];
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export function localDateTimeToIso(value: string): string | undefined {
  if (typeof value !== 'string' || value.length < 16 || value.length > 32) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function isConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object'
    && 'status' in error && (error as { status?: unknown }).status === 409);
}

export function documentTypeLabel(value: LegalDocumentType): string {
  return ({
    community: '社区规范',
    privacy: '隐私政策',
    refund: '退款规则',
    terms: '服务条款',
  } as const)[value];
}
