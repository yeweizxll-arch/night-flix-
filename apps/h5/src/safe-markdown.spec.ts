import { describe, expect, it } from 'vitest';

import { parseSafeMarkdown } from './safe-markdown';

describe('safe legal markdown', () => {
  it('parses headings, lists and code without creating HTML instructions', () => {
    expect(parseSafeMarkdown('# Terms\n- One\n- Two\n```\n<script>alert(1)</script>\n```'))
      .toEqual([
        { level: 1, text: 'Terms', type: 'heading' },
        { items: ['One', 'Two'], ordered: false, type: 'list' },
        { text: '<script>alert(1)</script>', type: 'code' },
      ]);
  });

  it('keeps raw HTML as inert text', () => {
    expect(parseSafeMarkdown('<img src=x onerror=alert(1)>'))
      .toEqual([{ text: '<img src=x onerror=alert(1)>', type: 'paragraph' }]);
  });
});
