import type { CustomerRequestInit } from './api/client';
import type { PrivacyExportPage, PrivacyExportSection } from './api/types';

interface PrivacyApi {
  request<T>(path: string, init?: CustomerRequestInit): Promise<T>;
}

export interface PrivacyExportDocument {
  exportedAt: string;
  items: unknown[];
  notice: string;
  section: PrivacyExportSection;
}

export async function collectPrivacyExport(
  api: PrivacyApi,
  section: PrivacyExportSection,
  currentPassword: string,
): Promise<PrivacyExportDocument> {
  let cursor: string | undefined;
  let exportedAt = '';
  let notice = '';
  const items: unknown[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 10_000; page += 1) {
    const response = await api.request<PrivacyExportPage>('/api/v1/customer/privacy/export', {
      cache: 'no-store',
      json: { currentPassword, ...(cursor ? { cursor } : {}), pageSize: 100, section },
      method: 'POST',
    });
    if (response.section !== section || !Array.isArray(response.items)) {
      throw new Error('Privacy export response mismatch');
    }
    items.push(...response.items);
    exportedAt = response.exportedAt;
    notice = response.notice;
    if (!response.nextCursor) return { exportedAt, items, notice, section };
    if (seen.has(response.nextCursor)) throw new Error('Privacy export cursor repeated');
    seen.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error('Privacy export exceeded the safe page limit');
}
