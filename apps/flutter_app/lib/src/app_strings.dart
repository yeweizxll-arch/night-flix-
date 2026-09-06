import 'package:flutter/widgets.dart';

import 'app_translations.dart';

const localeNames = <String, String>{
  'en-US': 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  'es-ES': 'Español',
  'pt-BR': 'Português (Brasil)',
  'id-ID': 'Bahasa Indonesia',
  'th-TH': 'ไทย',
  'vi-VN': 'Tiếng Việt',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
  'ar-SA': 'العربية',
  'hi-IN': 'हिन्दी',
  'tr-TR': 'Türkçe',
};

String translateAppString(Locale locale, String key, String fallback) {
  final tag = locale.toLanguageTag();
  return appTranslations[tag]?[key] ??
      appTranslations['en-US']?[key] ??
      fallback;
}

extension AppStrings on BuildContext {
  bool get isChinese => Localizations.localeOf(this).languageCode == 'zh';

  String tr(String key, String fallback) =>
      translateAppString(Localizations.localeOf(this), key, fallback);
}

Locale localeFromTag(String tag) {
  final parts = tag.split('-');
  return Locale(parts.first, parts.length > 1 ? parts[1] : null);
}
