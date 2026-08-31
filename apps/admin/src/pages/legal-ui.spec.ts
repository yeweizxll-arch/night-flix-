import { describe, expect, it } from 'vitest';

import { documentTypeLabel, localDateTimeToIso } from './legal-ui';

describe('legal admin UI helpers', () => {
  it('converts an explicit local publish time to an ISO timestamp', () => {
    expect(localDateTimeToIso('2030-01-02T03:04')).toMatch(/^2030-01-0[12]T/);
    expect(localDateTimeToIso('not-a-time')).toBeUndefined();
  });

  it('labels every legal document type without inventing an unknown type', () => {
    expect(documentTypeLabel('privacy')).toBe('隐私政策');
    expect(documentTypeLabel('community')).toBe('社区规范');
  });
});
