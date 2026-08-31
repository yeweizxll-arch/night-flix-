import { describe, expect, it } from 'vitest';

import {
  assertUniqueLocales,
  isDramaEditable,
  isDramaPublishable,
  isDramaRestorable,
  keywordList,
  optionalCanonicalIso,
} from './platform-content-library-ui';

describe('platform content management UI helpers', () => {
  it('requires canonical ISO schedules and preserves exact values', () => {
    expect(optionalCanonicalIso('2026-08-22T12:00:00.000Z'))
      .toBe('2026-08-22T12:00:00.000Z');
    expect(() => optionalCanonicalIso('2026-08-22 12:00')).toThrow(/ISO/);
    expect(optionalCanonicalIso('')).toBeUndefined();
  });

  it('normalizes keywords and rejects duplicate locales', () => {
    expect(keywordList('romance, short, romance')).toEqual(['romance', 'short']);
    expect(() => assertUniqueLocales([{ locale: 'zh-CN' }, { locale: 'zh-CN' }]))
      .toThrow(/语言/);
  });

  it('enforces edit/publish and 30-day restore visibility by state', () => {
    expect(isDramaEditable('draft')).toBe(true);
    expect(isDramaEditable('published')).toBe(false);
    expect(isDramaPublishable('unpublished')).toBe(true);
    expect(isDramaPublishable('approved')).toBe(false);
    expect(isDramaPublishable('published')).toBe(false);
    expect(isDramaRestorable(
      '2026-08-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      Date.parse('2026-08-22T00:00:00.000Z'),
    )).toBe(true);
    expect(isDramaRestorable(
      '2026-08-01T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
      Date.parse('2026-08-22T00:00:00.000Z'),
    )).toBe(false);
  });
});
