BEGIN;

CREATE OR REPLACE FUNCTION app.valid_content_scope(scope_type text, tenant_id uuid)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT (scope_type = 'platform' AND tenant_id IS NULL)
      OR (scope_type = 'tenant' AND tenant_id IS NOT NULL)
$function$;

CREATE OR REPLACE FUNCTION app.scope_can_reference(
  owner_type text,
  owner_tenant_id uuid,
  resource_owner_type text,
  resource_owner_tenant_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN owner_type = 'platform' THEN
      resource_owner_type = 'platform' AND resource_owner_tenant_id IS NULL
    WHEN owner_type = 'tenant' THEN
      resource_owner_type = 'platform'
      OR (
        resource_owner_type = 'tenant'
        AND resource_owner_tenant_id = owner_tenant_id
      )
    ELSE false
  END
$function$;

GRANT EXECUTE ON FUNCTION app.valid_content_scope(text, uuid) TO PUBLIC;
REVOKE ALL ON FUNCTION app.scope_can_reference(text, uuid, text, uuid) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS storage_providers (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  provider text NOT NULL,
  account_label text NOT NULL,
  endpoint text,
  bucket text NOT NULL,
  credential_ciphertext text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  cdn_base_url text,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT storage_providers_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT storage_providers_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT storage_providers_provider_check CHECK (
    provider ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT storage_providers_label_check CHECK (
    char_length(btrim(account_label)) BETWEEN 1 AND 100
  ),
  CONSTRAINT storage_providers_endpoint_check CHECK (
    endpoint IS NULL OR endpoint ~ '^https://'
  ),
  CONSTRAINT storage_providers_bucket_check CHECK (
    char_length(btrim(bucket)) BETWEEN 1 AND 255
  ),
  CONSTRAINT storage_providers_credential_check CHECK (
    char_length(credential_ciphertext) BETWEEN 20 AND 16384
  ),
  CONSTRAINT storage_providers_key_version_check CHECK (key_version > 0),
  CONSTRAINT storage_providers_cdn_check CHECK (
    cdn_base_url IS NULL OR cdn_base_url ~ '^https://'
  ),
  CONSTRAINT storage_providers_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT storage_providers_version_check CHECK (version >= 0),
  CONSTRAINT storage_providers_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS storage_providers_platform_label_unique_idx
  ON storage_providers (account_label)
  WHERE owner_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS storage_providers_tenant_label_unique_idx
  ON storage_providers (owner_tenant_id, account_label)
  WHERE owner_type = 'tenant';

CREATE INDEX IF NOT EXISTS storage_providers_tenant_status_idx
  ON storage_providers (owner_tenant_id, status)
  WHERE owner_type = 'tenant';

DROP TRIGGER IF EXISTS storage_providers_set_updated_at ON storage_providers;
CREATE TRIGGER storage_providers_set_updated_at
BEFORE UPDATE ON storage_providers
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  kind text NOT NULL,
  storage_provider_id uuid,
  object_key text,
  source_url text,
  mime_type text,
  size_bytes bigint,
  checksum text,
  status text NOT NULL DEFAULT 'pending',
  transcode_status text NOT NULL DEFAULT 'not_required',
  transcode_error text,
  duration_seconds integer,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restore_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT media_assets_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT media_assets_storage_provider_fk FOREIGN KEY (storage_provider_id)
    REFERENCES storage_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT media_assets_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT media_assets_kind_check CHECK (kind IN ('video', 'image', 'file')),
  CONSTRAINT media_assets_source_check CHECK (
    (
      storage_provider_id IS NOT NULL
      AND object_key IS NOT NULL
      AND source_url IS NULL
    )
    OR (
      storage_provider_id IS NULL
      AND object_key IS NULL
      AND source_url IS NOT NULL
      AND source_url ~ '^https://'
    )
  ),
  CONSTRAINT media_assets_object_key_check CHECK (
    object_key IS NULL OR char_length(btrim(object_key)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT media_assets_mime_type_check CHECK (
    mime_type IS NULL OR mime_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'
  ),
  CONSTRAINT media_assets_size_check CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT media_assets_checksum_check CHECK (
    checksum IS NULL OR char_length(checksum) BETWEEN 32 AND 512
  ),
  CONSTRAINT media_assets_status_check CHECK (
    status IN ('pending', 'uploading', 'processing', 'ready', 'failed', 'quarantined')
  ),
  CONSTRAINT media_assets_external_ready_check CHECK (
    status <> 'ready'
    OR source_url IS NULL
    OR (
      checksum IS NOT NULL
      AND metadata_json @> '{"immutable": true}'::jsonb
    )
  ),
  CONSTRAINT media_assets_transcode_status_check CHECK (
    transcode_status IN ('not_required', 'queued', 'processing', 'ready', 'failed')
    AND (kind = 'video' OR transcode_status = 'not_required')
  ),
  CONSTRAINT media_assets_transcode_error_check CHECK (
    (
      transcode_status = 'failed'
      AND transcode_error IS NOT NULL
      AND char_length(btrim(transcode_error)) BETWEEN 1 AND 4000
    )
    OR (transcode_status <> 'failed' AND transcode_error IS NULL)
  ),
  CONSTRAINT media_assets_duration_check CHECK (
    duration_seconds IS NULL OR duration_seconds >= 0
  ),
  CONSTRAINT media_assets_metadata_check CHECK (jsonb_typeof(metadata_json) = 'object'),
  CONSTRAINT media_assets_soft_delete_check CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 2000
      AND restore_until IS NOT NULL
      AND restore_until > deleted_at
    )
  ),
  CONSTRAINT media_assets_version_check CHECK (version >= 0),
  CONSTRAINT media_assets_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS media_assets_owner_status_idx
  ON media_assets (owner_tenant_id, kind, status, created_at DESC)
  WHERE owner_type = 'tenant' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS media_assets_transcode_queue_idx
  ON media_assets (transcode_status, created_at)
  WHERE kind = 'video' AND transcode_status IN ('queued', 'processing');

CREATE INDEX IF NOT EXISTS media_assets_restore_idx
  ON media_assets (owner_tenant_id, restore_until)
  WHERE deleted_at IS NOT NULL;

DROP TRIGGER IF EXISTS media_assets_set_updated_at ON media_assets;
CREATE TRIGGER media_assets_set_updated_at
BEFORE UPDATE ON media_assets
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  code citext NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restore_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT categories_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT categories_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT categories_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT categories_sort_check CHECK (sort_order BETWEEN -1000000 AND 1000000),
  CONSTRAINT categories_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT categories_soft_delete_check CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 2000
      AND restore_until IS NOT NULL
      AND restore_until > deleted_at
    )
  ),
  CONSTRAINT categories_version_check CHECK (version >= 0),
  CONSTRAINT categories_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_platform_code_unique_idx
  ON categories (code) WHERE owner_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS categories_tenant_code_unique_idx
  ON categories (owner_tenant_id, code) WHERE owner_type = 'tenant';

DROP TRIGGER IF EXISTS categories_set_updated_at ON categories;
CREATE TRIGGER categories_set_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS category_translations (
  id uuid PRIMARY KEY,
  category_id uuid NOT NULL,
  locale text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT category_translations_category_fk FOREIGN KEY (category_id)
    REFERENCES categories (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT category_translations_unique UNIQUE (category_id, locale),
  CONSTRAINT category_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT category_translations_name_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT category_translations_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS category_translations_set_updated_at ON category_translations;
CREATE TRIGGER category_translations_set_updated_at
BEFORE UPDATE ON category_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  code citext NOT NULL,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restore_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT tags_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tags_scope_check CHECK (app.valid_content_scope(owner_type, owner_tenant_id)),
  CONSTRAINT tags_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT tags_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tags_soft_delete_check CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 2000
      AND restore_until IS NOT NULL
      AND restore_until > deleted_at
    )
  ),
  CONSTRAINT tags_version_check CHECK (version >= 0),
  CONSTRAINT tags_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS tags_platform_code_unique_idx
  ON tags (code) WHERE owner_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS tags_tenant_code_unique_idx
  ON tags (owner_tenant_id, code) WHERE owner_type = 'tenant';

DROP TRIGGER IF EXISTS tags_set_updated_at ON tags;
CREATE TRIGGER tags_set_updated_at
BEFORE UPDATE ON tags
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS tag_translations (
  id uuid PRIMARY KEY,
  tag_id uuid NOT NULL,
  locale text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT tag_translations_tag_fk FOREIGN KEY (tag_id)
    REFERENCES tags (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT tag_translations_unique UNIQUE (tag_id, locale),
  CONSTRAINT tag_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT tag_translations_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT tag_translations_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS tag_translations_set_updated_at ON tag_translations;
CREATE TRIGGER tag_translations_set_updated_at
BEFORE UPDATE ON tag_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS dramas (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  code citext NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  release_at timestamptz,
  unpublish_at timestamptz,
  cover_file_id uuid,
  category_id uuid,
  total_episodes integer NOT NULL DEFAULT 0,
  source_type text NOT NULL DEFAULT 'upload',
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restore_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT dramas_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT dramas_cover_fk FOREIGN KEY (cover_file_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT dramas_category_fk FOREIGN KEY (category_id)
    REFERENCES categories (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT dramas_scope_check CHECK (app.valid_content_scope(owner_type, owner_tenant_id)),
  CONSTRAINT dramas_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,127}$'
  ),
  CONSTRAINT dramas_status_check CHECK (
    status IN (
      'draft', 'pending_review', 'approved', 'published',
      'unpublished', 'rejected'
    )
  ),
  CONSTRAINT dramas_schedule_check CHECK (
    unpublish_at IS NULL OR (release_at IS NOT NULL AND unpublish_at > release_at)
  ),
  CONSTRAINT dramas_total_episodes_check CHECK (total_episodes >= 0),
  CONSTRAINT dramas_source_type_check CHECK (source_type IN ('upload', 'url', 'import')),
  CONSTRAINT dramas_soft_delete_check CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 2000
      AND restore_until IS NOT NULL
      AND restore_until > deleted_at
    )
  ),
  CONSTRAINT dramas_version_check CHECK (version >= 0),
  CONSTRAINT dramas_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS dramas_platform_code_unique_idx
  ON dramas (code) WHERE owner_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS dramas_tenant_code_unique_idx
  ON dramas (owner_tenant_id, code) WHERE owner_type = 'tenant';

CREATE INDEX IF NOT EXISTS dramas_tenant_catalog_idx
  ON dramas (owner_tenant_id, status, release_at DESC, id)
  WHERE owner_type = 'tenant' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS dramas_platform_catalog_idx
  ON dramas (status, release_at DESC, id)
  WHERE owner_type = 'platform' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS dramas_restore_idx
  ON dramas (owner_tenant_id, restore_until)
  WHERE deleted_at IS NOT NULL;

DROP TRIGGER IF EXISTS dramas_set_updated_at ON dramas;
CREATE TRIGGER dramas_set_updated_at
BEFORE UPDATE ON dramas
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS drama_translations (
  id uuid PRIMARY KEY,
  drama_id uuid NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  search_keywords text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT drama_translations_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT drama_translations_unique UNIQUE (drama_id, locale),
  CONSTRAINT drama_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT drama_translations_title_check CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 300
  ),
  CONSTRAINT drama_translations_summary_check CHECK (char_length(summary) <= 20000),
  CONSTRAINT drama_translations_keywords_check CHECK (
    cardinality(search_keywords) <= 50
  ),
  CONSTRAINT drama_translations_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS drama_translations_locale_title_idx
  ON drama_translations (locale, title);

DROP TRIGGER IF EXISTS drama_translations_set_updated_at ON drama_translations;
CREATE TRIGGER drama_translations_set_updated_at
BEFORE UPDATE ON drama_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS episodes (
  id uuid PRIMARY KEY,
  drama_id uuid NOT NULL,
  episode_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  release_at timestamptz,
  unpublish_at timestamptz,
  duration_seconds integer NOT NULL DEFAULT 0,
  media_asset_id uuid NOT NULL,
  preview_seconds integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  restore_until timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT episodes_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT episodes_media_fk FOREIGN KEY (media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT episodes_unique UNIQUE (drama_id, episode_no),
  CONSTRAINT episodes_number_check CHECK (episode_no BETWEEN 1 AND 1000),
  CONSTRAINT episodes_status_check CHECK (
    status IN ('draft', 'approved', 'published', 'unpublished')
  ),
  CONSTRAINT episodes_schedule_check CHECK (
    unpublish_at IS NULL OR (release_at IS NOT NULL AND unpublish_at > release_at)
  ),
  CONSTRAINT episodes_duration_check CHECK (
    duration_seconds >= 0
    AND preview_seconds >= 0
    AND preview_seconds <= duration_seconds
  ),
  CONSTRAINT episodes_soft_delete_check CHECK (
    (
      deleted_at IS NULL AND deleted_by IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 2000
      AND restore_until IS NOT NULL
      AND restore_until > deleted_at
    )
  ),
  CONSTRAINT episodes_version_check CHECK (version >= 0),
  CONSTRAINT episodes_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS episodes_drama_status_idx
  ON episodes (drama_id, status, episode_no)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS episodes_media_idx ON episodes (media_asset_id);

CREATE INDEX IF NOT EXISTS episodes_restore_idx
  ON episodes (drama_id, restore_until)
  WHERE deleted_at IS NOT NULL;

DROP TRIGGER IF EXISTS episodes_set_updated_at ON episodes;
CREATE TRIGGER episodes_set_updated_at
BEFORE UPDATE ON episodes
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS episode_translations (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT episode_translations_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT episode_translations_unique UNIQUE (episode_id, locale),
  CONSTRAINT episode_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT episode_translations_title_check CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 300
  ),
  CONSTRAINT episode_translations_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS episode_translations_set_updated_at ON episode_translations;
CREATE TRIGGER episode_translations_set_updated_at
BEFORE UPDATE ON episode_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS drama_tags (
  drama_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT drama_tags_pk PRIMARY KEY (drama_id, tag_id),
  CONSTRAINT drama_tags_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT drama_tags_tag_fk FOREIGN KEY (tag_id)
    REFERENCES tags (id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS drama_tags_tag_idx ON drama_tags (tag_id, drama_id);

CREATE TABLE IF NOT EXISTS content_license_packages (
  id uuid PRIMARY KEY,
  code citext NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT content_license_packages_code_unique UNIQUE (code),
  CONSTRAINT content_license_packages_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,127}$'
  ),
  CONSTRAINT content_license_packages_name_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT content_license_packages_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT content_license_packages_version_check CHECK (version >= 0),
  CONSTRAINT content_license_packages_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS content_license_packages_set_updated_at ON content_license_packages;
CREATE TRIGGER content_license_packages_set_updated_at
BEFORE UPDATE ON content_license_packages
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_license_package_items (
  package_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT content_license_package_items_pk PRIMARY KEY (package_id, drama_id),
  CONSTRAINT content_license_package_items_package_fk FOREIGN KEY (package_id)
    REFERENCES content_license_packages (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT content_license_package_items_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS content_license_package_items_drama_idx
  ON content_license_package_items (drama_id, package_id);

CREATE TABLE IF NOT EXISTS content_licenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  license_type text NOT NULL,
  drama_id uuid,
  package_id uuid,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  scope_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  granted_by uuid NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT content_licenses_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_licenses_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_licenses_package_fk FOREIGN KEY (package_id)
    REFERENCES content_license_packages (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_licenses_granted_by_fk FOREIGN KEY (granted_by)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_licenses_revoked_by_fk FOREIGN KEY (revoked_by)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_licenses_scope_check CHECK (
    (license_type = 'drama' AND drama_id IS NOT NULL AND package_id IS NULL)
    OR (license_type = 'package' AND drama_id IS NULL AND package_id IS NOT NULL)
  ),
  CONSTRAINT content_licenses_period_check CHECK (expires_at > starts_at),
  CONSTRAINT content_licenses_status_check CHECK (
    status IN ('scheduled', 'active', 'expired', 'revoked')
  ),
  CONSTRAINT content_licenses_snapshot_check CHECK (
    jsonb_typeof(scope_snapshot_json) = 'object'
  ),
  CONSTRAINT content_licenses_revocation_check CHECK (
    (
      status <> 'revoked'
      AND revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL
    )
    OR (
      status = 'revoked'
      AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND char_length(btrim(revoke_reason)) BETWEEN 1 AND 2000
    )
  ),
  CONSTRAINT content_licenses_version_check CHECK (version >= 0),
  CONSTRAINT content_licenses_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT content_licenses_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS content_licenses_tenant_active_idx
  ON content_licenses (tenant_id, status, starts_at, expires_at);

CREATE INDEX IF NOT EXISTS content_licenses_drama_idx
  ON content_licenses (drama_id, tenant_id)
  WHERE license_type = 'drama';

CREATE INDEX IF NOT EXISTS content_licenses_package_idx
  ON content_licenses (package_id, tenant_id)
  WHERE license_type = 'package';

DROP TRIGGER IF EXISTS content_licenses_set_updated_at ON content_licenses;
CREATE TRIGGER content_licenses_set_updated_at
BEFORE UPDATE ON content_licenses
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_license_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  license_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT content_license_items_license_fk FOREIGN KEY (tenant_id, license_id)
    REFERENCES content_licenses (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT content_license_items_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_license_items_unique UNIQUE (license_id, drama_id),
  CONSTRAINT content_license_items_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS content_license_items_access_idx
  ON content_license_items (tenant_id, drama_id, license_id);

CREATE TABLE IF NOT EXISTS content_versions (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  version_no integer NOT NULL,
  snapshot_json jsonb NOT NULL,
  change_level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  CONSTRAINT content_versions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_versions_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT content_versions_aggregate_type_check CHECK (
    aggregate_type IN ('drama', 'episode', 'media_asset')
  ),
  CONSTRAINT content_versions_version_check CHECK (version_no > 0),
  CONSTRAINT content_versions_snapshot_check CHECK (jsonb_typeof(snapshot_json) = 'object'),
  CONSTRAINT content_versions_change_level_check CHECK (change_level IN ('minor', 'critical'))
);

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_platform_unique_idx
  ON content_versions (aggregate_type, aggregate_id, version_no)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_tenant_unique_idx
  ON content_versions (tenant_id, aggregate_type, aggregate_id, version_no)
  WHERE scope_type = 'tenant';

CREATE UNIQUE INDEX IF NOT EXISTS content_versions_tenant_id_id_unique_idx
  ON content_versions (tenant_id, id)
  WHERE tenant_id IS NOT NULL;

DROP TRIGGER IF EXISTS content_versions_prevent_update ON content_versions;
CREATE TRIGGER content_versions_prevent_update
BEFORE UPDATE OR DELETE ON content_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS review_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  content_version_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  submitted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  submitted_by uuid NOT NULL,
  reviewed_at timestamptz,
  reviewer_id uuid,
  reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT review_requests_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_requests_content_version_fk FOREIGN KEY (content_version_id)
    REFERENCES content_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_requests_submitted_by_fk FOREIGN KEY (tenant_id, submitted_by)
    REFERENCES tenant_staff (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_requests_reviewer_fk FOREIGN KEY (reviewer_id)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_requests_target_type_check CHECK (target_type IN ('drama', 'episode')),
  CONSTRAINT review_requests_status_check CHECK (
    status IN ('submitted', 'approved', 'rejected', 'withdrawn')
  ),
  CONSTRAINT review_requests_decision_check CHECK (
    (
      status = 'submitted'
      AND reviewed_at IS NULL AND reviewer_id IS NULL AND reason IS NULL
    )
    OR (
      status IN ('approved', 'rejected')
      AND reviewed_at IS NOT NULL AND reviewer_id IS NOT NULL
      AND (
        status = 'approved'
        OR (
          reason IS NOT NULL
          AND char_length(btrim(reason)) BETWEEN 1 AND 4000
        )
      )
    )
    OR (
      status = 'withdrawn'
      AND reviewed_at IS NULL AND reviewer_id IS NULL
    )
  ),
  CONSTRAINT review_requests_reviewed_timestamp_check CHECK (
    reviewed_at IS NULL OR reviewed_at >= submitted_at
  ),
  CONSTRAINT review_requests_version_check CHECK (version >= 0),
  CONSTRAINT review_requests_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT review_requests_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS review_requests_platform_queue_idx
  ON review_requests (status, submitted_at, id)
  WHERE status = 'submitted';

CREATE INDEX IF NOT EXISTS review_requests_tenant_idx
  ON review_requests (tenant_id, status, submitted_at DESC);

DROP TRIGGER IF EXISTS review_requests_set_updated_at ON review_requests;
CREATE TRIGGER review_requests_set_updated_at
BEFORE UPDATE ON review_requests
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS review_request_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  review_request_id uuid NOT NULL,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT review_request_actions_request_fk FOREIGN KEY (tenant_id, review_request_id)
    REFERENCES review_requests (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT review_request_actions_action_check CHECK (
    action IN ('submit', 'withdraw', 'approve', 'reject')
  ),
  CONSTRAINT review_request_actions_actor_check CHECK (
    (action IN ('submit', 'withdraw') AND actor_type = 'tenant_staff')
    OR (action IN ('approve', 'reject') AND actor_type = 'platform_staff')
  ),
  CONSTRAINT review_request_actions_reason_check CHECK (
    (
      action = 'reject'
      AND reason IS NOT NULL
      AND char_length(btrim(reason)) BETWEEN 1 AND 4000
    )
    OR (action <> 'reject' AND (reason IS NULL OR char_length(reason) <= 4000))
  )
);

CREATE INDEX IF NOT EXISTS review_request_actions_request_idx
  ON review_request_actions (tenant_id, review_request_id, created_at, id);

DROP TRIGGER IF EXISTS review_request_actions_prevent_update ON review_request_actions;
CREATE TRIGGER review_request_actions_prevent_update
BEFORE UPDATE OR DELETE ON review_request_actions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS content_schedule_jobs (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  executed_at timestamptz,
  idempotency_key text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT content_schedule_jobs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_schedule_jobs_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT content_schedule_jobs_target_check CHECK (target_type IN ('drama', 'episode')),
  CONSTRAINT content_schedule_jobs_action_check CHECK (action IN ('publish', 'unpublish')),
  CONSTRAINT content_schedule_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'completed', 'cancelled', 'failed')
  ),
  CONSTRAINT content_schedule_jobs_attempts_check CHECK (
    attempts >= 0 AND max_attempts > 0 AND attempts <= max_attempts
    AND (status IN ('pending', 'cancelled') OR attempts > 0)
    AND (status <> 'retry' OR attempts < max_attempts)
  ),
  CONSTRAINT content_schedule_jobs_error_check CHECK (
    (
      status IN ('retry', 'failed')
      AND last_error IS NOT NULL
      AND char_length(btrim(last_error)) BETWEEN 1 AND 4000
    )
    OR (status NOT IN ('retry', 'failed') AND last_error IS NULL)
  ),
  CONSTRAINT content_schedule_jobs_lock_check CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND char_length(btrim(locked_by)) BETWEEN 1 AND 200
    )
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT content_schedule_jobs_execution_check CHECK (
    (status = 'completed' AND executed_at IS NOT NULL)
    OR (status <> 'completed' AND executed_at IS NULL)
  ),
  CONSTRAINT content_schedule_jobs_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT content_schedule_jobs_version_check CHECK (version >= 0),
  CONSTRAINT content_schedule_jobs_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS content_schedule_jobs_platform_idempotency_unique_idx
  ON content_schedule_jobs (idempotency_key)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS content_schedule_jobs_tenant_idempotency_unique_idx
  ON content_schedule_jobs (tenant_id, idempotency_key)
  WHERE scope_type = 'tenant';

DROP INDEX IF EXISTS content_schedule_jobs_due_idx;
CREATE INDEX content_schedule_jobs_due_idx
  ON content_schedule_jobs (available_at, scheduled_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS content_schedule_jobs_locked_idx
  ON content_schedule_jobs (locked_at, id)
  WHERE status = 'processing';

DROP TRIGGER IF EXISTS content_schedule_jobs_set_updated_at ON content_schedule_jobs;
CREATE TRIGGER content_schedule_jobs_set_updated_at
BEFORE UPDATE ON content_schedule_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_deletion_history (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  restored_from_id uuid,
  previous_status text NOT NULL,
  resulting_status text NOT NULL,
  reason text NOT NULL,
  restore_until timestamptz,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT content_deletion_history_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_deletion_history_restored_from_fk FOREIGN KEY (restored_from_id)
    REFERENCES content_deletion_history (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_deletion_history_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT content_deletion_history_target_check CHECK (
    target_type IN ('drama', 'episode', 'media_asset', 'category', 'tag')
  ),
  CONSTRAINT content_deletion_history_action_check CHECK (
    action IN ('soft_delete', 'restore', 'purge')
  ),
  CONSTRAINT content_deletion_history_restore_check CHECK (
    (
      action = 'soft_delete'
      AND restored_from_id IS NULL
      AND restore_until IS NOT NULL
      AND restore_until > created_at
    )
    OR (
      action = 'restore'
      AND restored_from_id IS NOT NULL
      AND restore_until IS NULL
    )
    OR (
      action = 'purge'
      AND restored_from_id IS NULL
      AND restore_until IS NULL
    )
  ),
  CONSTRAINT content_deletion_history_status_check CHECK (
    char_length(previous_status) BETWEEN 1 AND 64
    AND char_length(resulting_status) BETWEEN 1 AND 64
  ),
  CONSTRAINT content_deletion_history_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT content_deletion_history_actor_check CHECK (
    (scope_type = 'platform' AND actor_type IN ('platform_staff', 'system'))
    OR (scope_type = 'tenant' AND actor_type IN ('tenant_staff', 'platform_staff', 'system'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS content_deletion_history_one_restore_idx
  ON content_deletion_history (restored_from_id)
  WHERE action = 'restore';

CREATE INDEX IF NOT EXISTS content_deletion_history_target_idx
  ON content_deletion_history (tenant_id, target_type, target_id, created_at DESC);

DROP TRIGGER IF EXISTS content_deletion_history_prevent_update ON content_deletion_history;
CREATE TRIGGER content_deletion_history_prevent_update
BEFORE UPDATE OR DELETE ON content_deletion_history
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS content_import_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  file_id uuid NOT NULL,
  format text NOT NULL,
  mode text NOT NULL DEFAULT 'create',
  status text NOT NULL DEFAULT 'uploaded',
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  validated_at timestamptz,
  confirmed_at timestamptz,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT content_import_jobs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_import_jobs_file_fk FOREIGN KEY (file_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_import_jobs_created_by_fk FOREIGN KEY (tenant_id, created_by)
    REFERENCES tenant_staff (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_import_jobs_format_check CHECK (format IN ('csv', 'xlsx')),
  CONSTRAINT content_import_jobs_mode_check CHECK (mode IN ('create', 'upsert')),
  CONSTRAINT content_import_jobs_status_check CHECK (
    status IN (
      'uploaded', 'validating', 'ready', 'importing',
      'completed', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT content_import_jobs_summary_check CHECK (jsonb_typeof(summary_json) = 'object'),
  CONSTRAINT content_import_jobs_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT content_import_jobs_lifecycle_check CHECK (
    (status IN ('uploaded', 'validating') AND validated_at IS NULL)
    OR (status IN ('ready', 'importing') AND validated_at IS NOT NULL)
    OR (
      status IN ('completed', 'failed', 'cancelled')
      AND (
        status = 'cancelled'
        OR validated_at IS NOT NULL
      )
    )
  ),
  CONSTRAINT content_import_jobs_completed_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT content_import_jobs_version_check CHECK (version >= 0),
  CONSTRAINT content_import_jobs_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT content_import_jobs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT content_import_jobs_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS content_import_jobs_tenant_status_idx
  ON content_import_jobs (tenant_id, status, created_at DESC);

DROP TRIGGER IF EXISTS content_import_jobs_set_updated_at ON content_import_jobs;
CREATE TRIGGER content_import_jobs_set_updated_at
BEFORE UPDATE ON content_import_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_import_rows (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_number integer NOT NULL,
  raw_json jsonb NOT NULL,
  normalized_json jsonb,
  status text NOT NULL DEFAULT 'pending',
  error_json jsonb,
  imported_drama_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT content_import_rows_job_fk FOREIGN KEY (tenant_id, job_id)
    REFERENCES content_import_jobs (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT content_import_rows_drama_fk FOREIGN KEY (imported_drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_import_rows_unique UNIQUE (job_id, row_number),
  CONSTRAINT content_import_rows_number_check CHECK (row_number > 0),
  CONSTRAINT content_import_rows_raw_check CHECK (jsonb_typeof(raw_json) = 'object'),
  CONSTRAINT content_import_rows_normalized_check CHECK (
    normalized_json IS NULL OR jsonb_typeof(normalized_json) = 'object'
  ),
  CONSTRAINT content_import_rows_status_check CHECK (
    status IN ('pending', 'valid', 'error', 'imported')
  ),
  CONSTRAINT content_import_rows_error_check CHECK (
    (status = 'error' AND error_json IS NOT NULL AND jsonb_typeof(error_json) = 'array')
    OR (status <> 'error' AND error_json IS NULL)
  ),
  CONSTRAINT content_import_rows_import_check CHECK (
    (status = 'imported' AND imported_drama_id IS NOT NULL)
    OR (status <> 'imported' AND imported_drama_id IS NULL)
  ),
  CONSTRAINT content_import_rows_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS content_import_rows_job_status_idx
  ON content_import_rows (tenant_id, job_id, status, row_number);

DROP TRIGGER IF EXISTS content_import_rows_set_updated_at ON content_import_rows;
CREATE TRIGGER content_import_rows_set_updated_at
BEFORE UPDATE ON content_import_rows
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS command_idempotency (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  route_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  response_status integer,
  response_json jsonb,
  resource_type text,
  resource_id uuid,
  locked_at timestamptz DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT command_idempotency_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT command_idempotency_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT command_idempotency_actor_type_check CHECK (
    actor_type ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  CONSTRAINT command_idempotency_route_check CHECK (
    char_length(btrim(route_key)) BETWEEN 3 AND 200
  ),
  CONSTRAINT command_idempotency_key_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT command_idempotency_request_hash_check CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT command_idempotency_status_check CHECK (
    status IN ('processing', 'completed', 'failed')
  ),
  CONSTRAINT command_idempotency_response_status_check CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  ),
  CONSTRAINT command_idempotency_processing_check CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND response_status IS NULL
      AND response_json IS NULL
    )
    OR (
      status IN ('completed', 'failed')
      AND locked_at IS NULL
      AND response_status IS NOT NULL
    )
  ),
  CONSTRAINT command_idempotency_resource_check CHECK (
    (resource_type IS NULL AND resource_id IS NULL)
    OR (
      resource_type IS NOT NULL
      AND resource_type ~ '^[a-z][a-z0-9_]{1,99}$'
      AND resource_id IS NOT NULL
    )
  ),
  CONSTRAINT command_idempotency_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT command_idempotency_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS command_idempotency_platform_key_unique_idx
  ON command_idempotency (actor_type, actor_id, route_key, idempotency_key)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS command_idempotency_tenant_key_unique_idx
  ON command_idempotency (
    tenant_id, actor_type, actor_id, route_key, idempotency_key
  )
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS command_idempotency_processing_lock_idx
  ON command_idempotency (locked_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS command_idempotency_expiry_idx
  ON command_idempotency (expires_at, id);

DROP TRIGGER IF EXISTS command_idempotency_set_updated_at ON command_idempotency;
CREATE TRIGGER command_idempotency_set_updated_at
BEFORE UPDATE ON command_idempotency
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  event_key text NOT NULL,
  idempotency_key text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  payload_json jsonb NOT NULL,
  headers_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT outbox_events_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outbox_events_event_key_unique UNIQUE (event_key),
  CONSTRAINT outbox_events_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT outbox_events_event_key_check CHECK (
    char_length(event_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT outbox_events_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT outbox_events_aggregate_type_check CHECK (
    aggregate_type ~ '^[a-z][a-z0-9_]{1,99}$'
  ),
  CONSTRAINT outbox_events_event_type_check CHECK (
    event_type ~ '^[A-Z][A-Za-z0-9]{2,99}$'
  ),
  CONSTRAINT outbox_events_event_version_check CHECK (event_version > 0),
  CONSTRAINT outbox_events_payload_check CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT outbox_events_headers_check CHECK (jsonb_typeof(headers_json) = 'object'),
  CONSTRAINT outbox_events_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'published', 'dead_letter')
  ),
  CONSTRAINT outbox_events_retry_check CHECK (
    retry_count >= 0 AND max_attempts > 0 AND retry_count <= max_attempts
    AND (status <> 'retry' OR retry_count < max_attempts)
  ),
  CONSTRAINT outbox_events_lock_check CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND char_length(btrim(locked_by)) BETWEEN 1 AND 200
    )
    OR (
      status <> 'processing'
      AND locked_at IS NULL
      AND locked_by IS NULL
    )
  ),
  CONSTRAINT outbox_events_publish_check CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT outbox_events_error_check CHECK (
    (
      status IN ('retry', 'dead_letter')
      AND last_error IS NOT NULL
      AND char_length(btrim(last_error)) BETWEEN 1 AND 4000
    )
    OR (status NOT IN ('retry', 'dead_letter') AND last_error IS NULL)
  ),
  CONSTRAINT outbox_events_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_platform_idempotency_unique_idx
  ON outbox_events (idempotency_key)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_tenant_idempotency_unique_idx
  ON outbox_events (tenant_id, idempotency_key)
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS outbox_events_available_idx
  ON outbox_events (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS outbox_events_locked_idx
  ON outbox_events (locked_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events (scope_type, tenant_id, aggregate_type, aggregate_id, created_at);

DROP TRIGGER IF EXISTS outbox_events_set_updated_at ON outbox_events;
CREATE TRIGGER outbox_events_set_updated_at
BEFORE UPDATE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS outbox_consumptions (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  event_id uuid NOT NULL,
  consumer_name text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  attempts integer NOT NULL DEFAULT 1,
  max_attempts integer NOT NULL DEFAULT 10,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT outbox_consumptions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outbox_consumptions_event_fk FOREIGN KEY (event_id)
    REFERENCES outbox_events (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT outbox_consumptions_event_consumer_unique UNIQUE (event_id, consumer_name),
  CONSTRAINT outbox_consumptions_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT outbox_consumptions_consumer_check CHECK (
    consumer_name ~ '^[a-z][a-z0-9_.-]{2,127}$'
  ),
  CONSTRAINT outbox_consumptions_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT outbox_consumptions_status_check CHECK (
    status IN ('processing', 'retry', 'completed', 'failed')
  ),
  CONSTRAINT outbox_consumptions_attempts_check CHECK (
    attempts > 0 AND max_attempts > 0 AND attempts <= max_attempts
    AND (status <> 'retry' OR attempts < max_attempts)
  ),
  CONSTRAINT outbox_consumptions_lock_check CHECK (
    (
      status = 'processing'
      AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL
      AND char_length(btrim(locked_by)) BETWEEN 1 AND 200
    )
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT outbox_consumptions_completed_check CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  ),
  CONSTRAINT outbox_consumptions_error_check CHECK (
    (
      status IN ('retry', 'failed')
      AND last_error IS NOT NULL
      AND char_length(btrim(last_error)) BETWEEN 1 AND 4000
    )
    OR (status NOT IN ('retry', 'failed') AND last_error IS NULL)
  ),
  CONSTRAINT outbox_consumptions_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_consumptions_platform_idempotency_unique_idx
  ON outbox_consumptions (consumer_name, idempotency_key)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS outbox_consumptions_tenant_idempotency_unique_idx
  ON outbox_consumptions (tenant_id, consumer_name, idempotency_key)
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS outbox_consumptions_locked_idx
  ON outbox_consumptions (locked_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS outbox_consumptions_available_idx
  ON outbox_consumptions (available_at, id)
  WHERE status = 'retry';

CREATE INDEX IF NOT EXISTS outbox_consumptions_failed_idx
  ON outbox_consumptions (updated_at, id)
  WHERE status = 'failed';

DROP TRIGGER IF EXISTS outbox_consumptions_set_updated_at ON outbox_consumptions;
CREATE TRIGGER outbox_consumptions_set_updated_at
BEFORE UPDATE ON outbox_consumptions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_media_storage_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  resource_owner_type text;
  resource_owner_tenant_id uuid;
BEGIN
  IF NEW.storage_provider_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT owner_type, owner_tenant_id
    INTO resource_owner_type, resource_owner_tenant_id
  FROM storage_providers
  WHERE id = NEW.storage_provider_id;

  IF NOT FOUND OR NOT app.scope_can_reference(
    NEW.owner_type,
    NEW.owner_tenant_id,
    resource_owner_type,
    resource_owner_tenant_id
  ) THEN
    RAISE EXCEPTION 'Media asset cannot reference storage provider outside its scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS media_assets_enforce_storage_scope ON media_assets;
CREATE TRIGGER media_assets_enforce_storage_scope
BEFORE INSERT OR UPDATE OF owner_type, owner_tenant_id, storage_provider_id ON media_assets
FOR EACH ROW EXECUTE FUNCTION app.enforce_media_storage_scope();

CREATE OR REPLACE FUNCTION app.enforce_drama_resource_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  resource_owner_type text;
  resource_owner_tenant_id uuid;
BEGIN
  IF NEW.cover_file_id IS NOT NULL THEN
    SELECT owner_type, owner_tenant_id
      INTO resource_owner_type, resource_owner_tenant_id
    FROM media_assets WHERE id = NEW.cover_file_id;

    IF NOT FOUND OR NOT app.scope_can_reference(
      NEW.owner_type, NEW.owner_tenant_id, resource_owner_type, resource_owner_tenant_id
    ) THEN
      RAISE EXCEPTION 'Drama cover is outside the drama scope' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.category_id IS NOT NULL THEN
    SELECT owner_type, owner_tenant_id
      INTO resource_owner_type, resource_owner_tenant_id
    FROM categories WHERE id = NEW.category_id;

    IF NOT FOUND OR NOT app.scope_can_reference(
      NEW.owner_type, NEW.owner_tenant_id, resource_owner_type, resource_owner_tenant_id
    ) THEN
      RAISE EXCEPTION 'Drama category is outside the drama scope' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS dramas_enforce_resource_scope ON dramas;
CREATE TRIGGER dramas_enforce_resource_scope
BEFORE INSERT OR UPDATE OF owner_type, owner_tenant_id, cover_file_id, category_id ON dramas
FOR EACH ROW EXECUTE FUNCTION app.enforce_drama_resource_scope();

CREATE OR REPLACE FUNCTION app.enforce_episode_media_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  drama_owner_type text;
  drama_owner_tenant_id uuid;
  media_owner_type text;
  media_owner_tenant_id uuid;
BEGIN
  SELECT owner_type, owner_tenant_id
    INTO drama_owner_type, drama_owner_tenant_id
  FROM dramas WHERE id = NEW.drama_id;

  SELECT owner_type, owner_tenant_id
    INTO media_owner_type, media_owner_tenant_id
  FROM media_assets WHERE id = NEW.media_asset_id;

  IF drama_owner_type IS NULL OR media_owner_type IS NULL
    OR NOT app.scope_can_reference(
      drama_owner_type, drama_owner_tenant_id, media_owner_type, media_owner_tenant_id
    ) THEN
    RAISE EXCEPTION 'Episode media is outside the drama scope' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS episodes_enforce_media_scope ON episodes;
CREATE TRIGGER episodes_enforce_media_scope
BEFORE INSERT OR UPDATE OF drama_id, media_asset_id ON episodes
FOR EACH ROW EXECUTE FUNCTION app.enforce_episode_media_scope();

CREATE OR REPLACE FUNCTION app.enforce_drama_tag_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  drama_owner_type text;
  drama_owner_tenant_id uuid;
  tag_owner_type text;
  tag_owner_tenant_id uuid;
BEGIN
  SELECT owner_type, owner_tenant_id
    INTO drama_owner_type, drama_owner_tenant_id
  FROM dramas WHERE id = NEW.drama_id;

  SELECT owner_type, owner_tenant_id
    INTO tag_owner_type, tag_owner_tenant_id
  FROM tags WHERE id = NEW.tag_id;

  IF drama_owner_type IS NULL OR tag_owner_type IS NULL
    OR NOT app.scope_can_reference(
      drama_owner_type, drama_owner_tenant_id, tag_owner_type, tag_owner_tenant_id
    ) THEN
    RAISE EXCEPTION 'Tag is outside the drama scope' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS drama_tags_enforce_scope ON drama_tags;
CREATE TRIGGER drama_tags_enforce_scope
BEFORE INSERT OR UPDATE OF drama_id, tag_id ON drama_tags
FOR EACH ROW EXECUTE FUNCTION app.enforce_drama_tag_scope();

CREATE OR REPLACE FUNCTION app.enforce_license_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_owner_type text;
BEGIN
  IF NEW.license_type = 'drama' THEN
    SELECT owner_type INTO target_owner_type FROM dramas WHERE id = NEW.drama_id;
    IF target_owner_type IS DISTINCT FROM 'platform' THEN
      RAISE EXCEPTION 'Only platform dramas can be licensed' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_licenses_enforce_scope ON content_licenses;
CREATE TRIGGER content_licenses_enforce_scope
BEFORE INSERT OR UPDATE OF license_type, drama_id, package_id ON content_licenses
FOR EACH ROW EXECUTE FUNCTION app.enforce_license_scope();

CREATE OR REPLACE FUNCTION app.enforce_license_item_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  license_tenant uuid;
  drama_owner_type text;
BEGIN
  SELECT tenant_id INTO license_tenant FROM content_licenses WHERE id = NEW.license_id;
  SELECT owner_type INTO drama_owner_type FROM dramas WHERE id = NEW.drama_id;

  IF license_tenant IS DISTINCT FROM NEW.tenant_id
    OR drama_owner_type IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'License snapshot item scope is invalid' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_license_items_enforce_scope ON content_license_items;
CREATE TRIGGER content_license_items_enforce_scope
BEFORE INSERT OR UPDATE OF tenant_id, license_id, drama_id ON content_license_items
FOR EACH ROW EXECUTE FUNCTION app.enforce_license_item_scope();

CREATE OR REPLACE FUNCTION app.enforce_package_item_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  drama_owner_type text;
BEGIN
  SELECT owner_type INTO drama_owner_type FROM dramas WHERE id = NEW.drama_id;
  IF drama_owner_type IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'License packages can contain only platform dramas'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_license_package_items_enforce_scope
  ON content_license_package_items;
CREATE TRIGGER content_license_package_items_enforce_scope
BEFORE INSERT OR UPDATE OF drama_id ON content_license_package_items
FOR EACH ROW EXECUTE FUNCTION app.enforce_package_item_scope();

CREATE OR REPLACE FUNCTION app.content_target_matches_scope(
  requested_scope text,
  requested_tenant uuid,
  requested_type text,
  requested_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  target_scope text;
  target_tenant uuid;
BEGIN
  CASE requested_type
    WHEN 'drama' THEN
      SELECT owner_type, owner_tenant_id INTO target_scope, target_tenant
      FROM dramas WHERE id = requested_id;
    WHEN 'episode' THEN
      SELECT drama.owner_type, drama.owner_tenant_id INTO target_scope, target_tenant
      FROM episodes AS episode
      INNER JOIN dramas AS drama ON drama.id = episode.drama_id
      WHERE episode.id = requested_id;
    WHEN 'media_asset' THEN
      SELECT owner_type, owner_tenant_id INTO target_scope, target_tenant
      FROM media_assets WHERE id = requested_id;
    WHEN 'category' THEN
      SELECT owner_type, owner_tenant_id INTO target_scope, target_tenant
      FROM categories WHERE id = requested_id;
    WHEN 'tag' THEN
      SELECT owner_type, owner_tenant_id INTO target_scope, target_tenant
      FROM tags WHERE id = requested_id;
    ELSE
      RETURN false;
  END CASE;

  RETURN target_scope IS NOT NULL
    AND target_scope = requested_scope
    AND target_tenant IS NOT DISTINCT FROM requested_tenant;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_content_target_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT app.content_target_matches_scope(
    NEW.scope_type, NEW.tenant_id, NEW.target_type, NEW.target_id
  ) THEN
    RAISE EXCEPTION 'Content target does not match its declared scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_schedule_jobs_enforce_target ON content_schedule_jobs;
CREATE TRIGGER content_schedule_jobs_enforce_target
BEFORE INSERT OR UPDATE OF scope_type, tenant_id, target_type, target_id
ON content_schedule_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_target_scope();

DROP TRIGGER IF EXISTS content_deletion_history_enforce_target ON content_deletion_history;
CREATE TRIGGER content_deletion_history_enforce_target
BEFORE INSERT OR UPDATE OF scope_type, tenant_id, target_type, target_id
ON content_deletion_history
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_target_scope();

CREATE OR REPLACE FUNCTION app.enforce_content_version_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT app.content_target_matches_scope(
    NEW.scope_type, NEW.tenant_id, NEW.aggregate_type, NEW.aggregate_id
  ) THEN
    RAISE EXCEPTION 'Content version target does not match its declared scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_versions_enforce_target ON content_versions;
CREATE TRIGGER content_versions_enforce_target
BEFORE INSERT OR UPDATE OF scope_type, tenant_id, aggregate_type, aggregate_id
ON content_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_version_scope();

CREATE OR REPLACE FUNCTION app.enforce_review_request_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  version_tenant uuid;
  version_scope text;
  version_aggregate_type text;
  version_aggregate_id uuid;
BEGIN
  SELECT tenant_id, scope_type, aggregate_type, aggregate_id
    INTO version_tenant, version_scope, version_aggregate_type, version_aggregate_id
  FROM content_versions
  WHERE id = NEW.content_version_id;

  IF version_scope IS DISTINCT FROM 'tenant'
    OR version_tenant IS DISTINCT FROM NEW.tenant_id
    OR version_aggregate_type IS DISTINCT FROM NEW.target_type
    OR version_aggregate_id IS DISTINCT FROM NEW.target_id THEN
    RAISE EXCEPTION 'Review request must reference the matching tenant content version'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS review_requests_enforce_scope ON review_requests;
CREATE TRIGGER review_requests_enforce_scope
BEFORE INSERT OR UPDATE OF tenant_id, target_type, target_id, content_version_id
ON review_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_review_request_scope();

CREATE OR REPLACE FUNCTION app.enforce_review_request_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.content_version_id IS DISTINCT FROM OLD.content_version_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Review request identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'submitted'
    OR NEW.status NOT IN ('approved', 'rejected', 'withdrawn')
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Invalid review request state transition' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS review_requests_enforce_transition ON review_requests;
CREATE TRIGGER review_requests_enforce_transition
BEFORE UPDATE ON review_requests
FOR EACH ROW EXECUTE FUNCTION app.enforce_review_request_transition();

CREATE OR REPLACE FUNCTION app.enforce_import_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  file_owner_type text;
  file_owner_tenant uuid;
BEGIN
  SELECT owner_type, owner_tenant_id INTO file_owner_type, file_owner_tenant
  FROM media_assets WHERE id = NEW.file_id;

  IF file_owner_type IS DISTINCT FROM 'tenant'
    OR file_owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Import file must belong to the importing tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_import_jobs_enforce_scope ON content_import_jobs;
CREATE TRIGGER content_import_jobs_enforce_scope
BEFORE INSERT OR UPDATE OF tenant_id, file_id ON content_import_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_import_scope();

CREATE OR REPLACE FUNCTION app.enforce_restore_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  original content_deletion_history%ROWTYPE;
BEGIN
  IF NEW.action <> 'restore' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO original
  FROM content_deletion_history
  WHERE id = NEW.restored_from_id;

  IF NOT FOUND
    OR original.action <> 'soft_delete'
    OR original.scope_type <> NEW.scope_type
    OR original.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR original.target_type <> NEW.target_type
    OR original.target_id <> NEW.target_id
    OR original.restore_until < NEW.created_at THEN
    RAISE EXCEPTION 'Restore must reference an unexpired soft-delete event for the same target'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_deletion_history_enforce_restore ON content_deletion_history;
CREATE TRIGGER content_deletion_history_enforce_restore
BEFORE INSERT OR UPDATE OF action, restored_from_id, scope_type, tenant_id, target_type, target_id
ON content_deletion_history
FOR EACH ROW EXECUTE FUNCTION app.enforce_restore_reference();

CREATE OR REPLACE FUNCTION app.enforce_outbox_consumption_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  event_scope text;
  event_tenant uuid;
BEGIN
  SELECT scope_type, tenant_id INTO event_scope, event_tenant
  FROM outbox_events WHERE id = NEW.event_id;

  IF event_scope IS DISTINCT FROM NEW.scope_type
    OR event_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Outbox consumption scope must match its event scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS outbox_consumptions_enforce_scope ON outbox_consumptions;
CREATE TRIGGER outbox_consumptions_enforce_scope
BEFORE INSERT OR UPDATE OF scope_type, tenant_id, event_id ON outbox_consumptions
FOR EACH ROW EXECUTE FUNCTION app.enforce_outbox_consumption_scope();

REVOKE ALL ON FUNCTION app.enforce_media_storage_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_drama_resource_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_episode_media_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_drama_tag_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_license_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_license_item_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_package_item_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.content_target_matches_scope(text, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_content_target_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_content_version_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_review_request_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_review_request_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_import_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_restore_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_outbox_consumption_scope() FROM PUBLIC;

COMMIT;
