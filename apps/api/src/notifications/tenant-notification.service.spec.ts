import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { safeDeepLink } from './tenant-notification.service';

describe('notification campaign input policy', () => {
  it.each([
    'https://example.com/path', 'http://example.com', 'javascript:alert(1)',
    '//example.com/path', 'custom://route', '/safe\\evil', '/line\nfeed',
  ])('rejects non-local or ambiguous deep link %s', (value) => {
    expect(() => safeDeepLink(value)).toThrow(BadRequestException);
  });

  it('allows only an app-local route', () => {
    expect(safeDeepLink('/dramas/abc?episode=1')).toBe('/dramas/abc?episode=1');
  });
});
