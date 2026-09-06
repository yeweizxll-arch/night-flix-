export const SUPPORTED_APP_LOCALES = ["zh-CN","zh-TW","en-US","fr-FR","ja-JP","ko-KR","es-ES","pt-BR","id-ID","th-TH","vi-VN","de-DE","ar-SA","hi-IN","tr-TR"] as const;
export type AppLocale = (typeof SUPPORTED_APP_LOCALES)[number];
export const APP_LOCALE_NAMES: Record<AppLocale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  "en-US": "English",
  "fr-FR": "Français",
  "ja-JP": "日本語",
  "ko-KR": "한국어",
  "es-ES": "Español",
  "pt-BR": "Português (Brasil)",
  "id-ID": "Bahasa Indonesia",
  "th-TH": "ไทย",
  "vi-VN": "Tiếng Việt",
  "de-DE": "Deutsch",
  "ar-SA": "العربية",
  "hi-IN": "हिन्दी",
  "tr-TR": "Türkçe"
};
export const APP_LOCALE_OPTIONS = SUPPORTED_APP_LOCALES.map(value => ({ value, label: APP_LOCALE_NAMES[value] }));
