import { describe, expect, it } from 'vitest';

import { CONTENT_LOCALES } from './api/types';
import { translate, translationKeys } from './i18n';

describe('translations', () => {
  it('keeps all six locale dictionaries complete', () => {
    const baseline = translationKeys('en-US').sort();
    for (const locale of CONTENT_LOCALES) expect(translationKeys(locale).sort()).toEqual(baseline);
  });

  it('does not expose obsolete integration or internal-build copy on production-visible states', () => {
    const keys = ['locked', 'paymentUnavailable', 'previewUnavailable', 'registrationUnavailable'] as const;
    const obsolete = /internal build|until .*available|until .*approved|接入前|接口完成前|驗收前|验收前|內部測試|内部测试|version interne|jusqu['’]à|validation du service|gestion du consentement|接続まで|完成まで|承認まで|内部テスト|연동 전|준비될 때까지|승인 전|내부 테스트/i;
    for (const locale of CONTENT_LOCALES) {
      expect(keys.map((key) => translate(locale, key)).join(' ')).not.toMatch(obsolete);
    }
  });
});
