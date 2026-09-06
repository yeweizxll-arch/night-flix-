BEGIN;

-- Keep database, API, content editors and native client on one locale set.
ALTER TABLE tenants DROP CONSTRAINT tenants_locale_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_locale_check CHECK (default_locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE category_translations DROP CONSTRAINT category_translations_locale_check;
ALTER TABLE category_translations ADD CONSTRAINT category_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE tag_translations DROP CONSTRAINT tag_translations_locale_check;
ALTER TABLE tag_translations ADD CONSTRAINT tag_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE drama_translations DROP CONSTRAINT drama_translations_locale_check;
ALTER TABLE drama_translations ADD CONSTRAINT drama_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE episode_translations DROP CONSTRAINT episode_translations_locale_check;
ALTER TABLE episode_translations ADD CONSTRAINT episode_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE membership_plan_translations DROP CONSTRAINT membership_plan_translations_locale_check;
ALTER TABLE membership_plan_translations ADD CONSTRAINT membership_plan_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE points_topup_package_translations DROP CONSTRAINT points_topup_package_translations_locale_check;
ALTER TABLE points_topup_package_translations ADD CONSTRAINT points_topup_package_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE orders DROP CONSTRAINT orders_locale_check;
ALTER TABLE orders ADD CONSTRAINT orders_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE customer_notification_preferences DROP CONSTRAINT customer_notification_preferences_locale_check;
ALTER TABLE customer_notification_preferences ADD CONSTRAINT customer_notification_preferences_locale_check CHECK (preferred_locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE notification_campaign_translations DROP CONSTRAINT notification_campaign_translations_locale_check;
ALTER TABLE notification_campaign_translations ADD CONSTRAINT notification_campaign_translations_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE notification_campaign_recipients DROP CONSTRAINT notification_campaign_recipients_locale_check;
ALTER TABLE notification_campaign_recipients ADD CONSTRAINT notification_campaign_recipients_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE customer_inbox_messages DROP CONSTRAINT customer_inbox_messages_locale_check;
ALTER TABLE customer_inbox_messages ADD CONSTRAINT customer_inbox_messages_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE tenant_legal_document_versions DROP CONSTRAINT tenant_legal_documents_locale_check;
ALTER TABLE tenant_legal_document_versions ADD CONSTRAINT tenant_legal_documents_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

ALTER TABLE customer_legal_consents DROP CONSTRAINT customer_legal_consents_locale_check;
ALTER TABLE customer_legal_consents ADD CONSTRAINT customer_legal_consents_locale_check CHECK (locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'));

CREATE OR REPLACE FUNCTION app.valid_locale_codes(value text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
  SELECT cardinality(value) BETWEEN 1 AND 15
    AND value <@ ARRAY['zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR']::text[]
    AND cardinality(value) = (SELECT count(DISTINCT locale) FROM unnest(value) locale);
$function$;

COMMIT;
