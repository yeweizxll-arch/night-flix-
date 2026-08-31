BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS site_name text,
  ADD COLUMN IF NOT EXISTS logo_media_asset_id uuid,
  ADD COLUMN IF NOT EXISTS icon_media_asset_id uuid,
  ADD COLUMN IF NOT EXISTS platform_site_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS theme_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION app.valid_tenant_theme(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT
    jsonb_typeof(value) = 'object'
    AND pg_column_size(value) <= 1024
    AND value - ARRAY['primaryColor', 'accentColor', 'colorMode'] = '{}'::jsonb
    AND (
      NOT value ? 'primaryColor'
      OR value ->> 'primaryColor' ~ '^#[0-9a-fA-F]{6}$'
    )
    AND (
      NOT value ? 'accentColor'
      OR value ->> 'accentColor' ~ '^#[0-9a-fA-F]{6}$'
    )
    AND (
      NOT value ? 'colorMode'
      OR value ->> 'colorMode' IN ('light', 'dark', 'system')
    )
$function$;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_site_name_check'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_site_name_check CHECK (
      site_name IS NULL OR char_length(btrim(site_name)) BETWEEN 1 AND 200
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_logo_media_asset_fk'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_logo_media_asset_fk
      FOREIGN KEY (logo_media_asset_id) REFERENCES media_assets (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_icon_media_asset_fk'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_icon_media_asset_fk
      FOREIGN KEY (icon_media_asset_id) REFERENCES media_assets (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_theme_json_check'
      AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_theme_json_check CHECK (
      app.valid_tenant_theme(theme_json)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_domains_custom_primary_tls_check'
      AND conrelid = 'tenant_domains'::regclass
  ) THEN
    ALTER TABLE tenant_domains
      ADD CONSTRAINT tenant_domains_custom_primary_tls_check CHECK (
        NOT is_primary OR type = 'subdomain' OR tls_status = 'active'
      ) NOT VALID;
  END IF;
END
$block$;

CREATE OR REPLACE FUNCTION app.resolve_tenant_by_host(requested_host text)
RETURNS TABLE (id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    tenant.id,
    CASE
      WHEN tenant.status = 'active' AND tenant.expires_at <= statement_timestamp()
        THEN 'expired'
      ELSE tenant.status
    END AS status
  FROM public.tenant_domains AS domain
  INNER JOIN public.tenants AS tenant ON tenant.id = domain.tenant_id
  WHERE domain.host::text = regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(requested_host)), '\.$', ''),
      ':[0-9]+$',
      ''
    ),
    '\.$',
    ''
  )
    AND domain.verified_at IS NOT NULL
    AND domain.disabled_at IS NULL
    AND (domain.type = 'subdomain' OR domain.tls_status = 'active')
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION app.resolve_tenant_by_host(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.enforce_tenant_branding_media()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  requested_id uuid;
BEGIN
  FOREACH requested_id IN ARRAY ARRAY[NEW.logo_media_asset_id, NEW.icon_media_asset_id]
  LOOP
    IF requested_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.media_assets AS media
      WHERE media.id = requested_id
        AND media.owner_type = 'tenant'
        AND media.owner_tenant_id = NEW.id
        AND media.kind = 'image'
        AND media.status = 'ready'
        AND media.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'branding media must be a ready tenant-owned image'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenants_enforce_branding_media ON tenants;
CREATE TRIGGER tenants_enforce_branding_media
BEFORE INSERT OR UPDATE OF logo_media_asset_id, icon_media_asset_id ON tenants
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_branding_media();

CREATE OR REPLACE FUNCTION app.enforce_platform_customer_site_enabled()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenants
    WHERE id = NEW.tenant_id AND platform_site_enabled
  ) THEN
    RAISE EXCEPTION 'customer site is disabled by the platform'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_comments_enforce_platform_site
  ON interaction_comments;
CREATE TRIGGER interaction_comments_enforce_platform_site
BEFORE INSERT OR UPDATE OF tenant_id, drama_id, episode_id, account_id
ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_platform_customer_site_enabled();

DROP TRIGGER IF EXISTS interaction_bullet_enforce_platform_site
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_enforce_platform_site
BEFORE INSERT OR UPDATE OF tenant_id, drama_id, episode_id, account_id
ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_platform_customer_site_enabled();

DROP TRIGGER IF EXISTS interaction_reports_enforce_platform_site
  ON interaction_reports;
CREATE TRIGGER interaction_reports_enforce_platform_site
BEFORE INSERT OR UPDATE OF tenant_id, reporter_account_id
ON interaction_reports
FOR EACH ROW EXECUTE FUNCTION app.enforce_platform_customer_site_enabled();

COMMENT ON COLUMN tenants.site_name IS
  'Customer-facing white-label site name. NULL falls back to tenants.name.';
COMMENT ON COLUMN tenants.logo_media_asset_id IS
  'Ready image asset selected as the customer-site logo.';
COMMENT ON COLUMN tenants.icon_media_asset_id IS
  'Ready image asset selected as the customer-site icon.';
COMMENT ON COLUMN tenants.platform_site_enabled IS
  'Platform safety switch. Customer access requires this and user_site_enabled.';
COMMENT ON COLUMN tenants.theme_json IS
  'Validated, non-sensitive customer-site theme options only.';

COMMIT;
