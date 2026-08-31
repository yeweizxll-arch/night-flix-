BEGIN;

ALTER TABLE dramas
  ADD COLUMN IF NOT EXISTS shanchuang_work_id text,
  ADD COLUMN IF NOT EXISTS shanchuang_creator_id text,
  ADD COLUMN IF NOT EXISTS public_revision integer,
  ADD COLUMN IF NOT EXISTS supersedes_drama_id uuid,
  ADD COLUMN IF NOT EXISTS public_release_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS emergency_takedown_at timestamptz,
  ADD COLUMN IF NOT EXISTS emergency_takedown_reason text;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dramas_supersedes_fk' AND conrelid = 'dramas'::regclass
  ) THEN
    ALTER TABLE dramas ADD CONSTRAINT dramas_supersedes_fk
      FOREIGN KEY (supersedes_drama_id) REFERENCES dramas (id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dramas_shanchuang_source_check'
      AND conrelid = 'dramas'::regclass
  ) THEN
    ALTER TABLE dramas ADD CONSTRAINT dramas_shanchuang_source_check CHECK (
      (
        shanchuang_work_id IS NULL AND shanchuang_creator_id IS NULL
        AND public_revision IS NULL AND supersedes_drama_id IS NULL
      ) OR (
        owner_type = 'platform' AND owner_tenant_id IS NULL
        AND char_length(btrim(shanchuang_work_id)) BETWEEN 1 AND 200
        AND char_length(btrim(shanchuang_creator_id)) BETWEEN 1 AND 200
        AND public_revision BETWEEN 1 AND 1000000
      )
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dramas_emergency_takedown_check'
      AND conrelid = 'dramas'::regclass
  ) THEN
    ALTER TABLE dramas ADD CONSTRAINT dramas_emergency_takedown_check CHECK (
      (emergency_takedown_at IS NULL AND emergency_takedown_reason IS NULL)
      OR (
        emergency_takedown_at IS NOT NULL
        AND char_length(btrim(emergency_takedown_reason)) BETWEEN 1 AND 2000
      )
    );
  END IF;
END
$block$;

CREATE UNIQUE INDEX IF NOT EXISTS dramas_shanchuang_revision_unique_idx
  ON dramas (shanchuang_work_id, public_revision)
  WHERE owner_type = 'platform' AND shanchuang_work_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dramas_public_pool_idx
  ON dramas (status, emergency_takedown_at, created_at DESC, id DESC)
  WHERE owner_type = 'platform' AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION app.valid_country_codes(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT cardinality(value) <= 250
    AND coalesce(bool_and(country ~ '^[A-Z]{2}$'), true)
  FROM unnest(value) AS country
$function$;

CREATE OR REPLACE FUNCTION app.valid_locale_codes(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT cardinality(value) BETWEEN 1 AND 50
    AND coalesce(bool_and(locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'), false)
  FROM unnest(value) AS locale
$function$;

CREATE TABLE IF NOT EXISTS tenant_public_drama_publications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  supporting_license_id uuid,
  status text NOT NULL DEFAULT 'pending_review',
  review_note text,
  allowed_countries text[] NOT NULL DEFAULT '{}'::text[],
  blocked_countries text[] NOT NULL DEFAULT '{}'::text[],
  reviewed_at timestamptz,
  reviewed_by uuid,
  published_at timestamptz,
  unpublished_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL,
  CONSTRAINT tenant_public_drama_publications_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_public_drama_publications_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_public_drama_publications_license_fk
    FOREIGN KEY (supporting_license_id) REFERENCES content_licenses (id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_public_drama_publications_unique UNIQUE (tenant_id, drama_id),
  CONSTRAINT tenant_public_drama_publications_status_check CHECK (
    status IN ('pending_review', 'approved', 'published', 'rejected', 'unpublished')
  ),
  CONSTRAINT tenant_public_drama_publications_review_note_check CHECK (
    review_note IS NULL OR char_length(btrim(review_note)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT tenant_public_drama_publications_country_check CHECK (
    app.valid_country_codes(allowed_countries)
    AND app.valid_country_codes(blocked_countries)
    AND NOT allowed_countries && blocked_countries
  ),
  CONSTRAINT tenant_public_drama_publications_state_check CHECK (
    (status = 'pending_review' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (status IN ('approved', 'rejected')
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    OR (status IN ('published', 'unpublished')
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
      AND published_at IS NOT NULL)
  ),
  CONSTRAINT tenant_public_drama_publications_version_check CHECK (version >= 0),
  CONSTRAINT tenant_public_drama_publications_timestamp_check CHECK (
    updated_at >= created_at
    AND (reviewed_at IS NULL OR reviewed_at >= created_at)
    AND (published_at IS NULL OR published_at >= reviewed_at)
    AND (unpublished_at IS NULL OR unpublished_at >= published_at)
  )
);

CREATE INDEX IF NOT EXISTS tenant_public_drama_publications_pool_idx
  ON tenant_public_drama_publications (tenant_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tenant_public_drama_publications_drama_idx
  ON tenant_public_drama_publications (drama_id, status, tenant_id);

CREATE OR REPLACE FUNCTION app.tenant_has_drama_license(requested_drama_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT app.current_tenant_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.content_license_items AS item
        INNER JOIN public.content_licenses AS license
          ON license.id = item.license_id
         AND license.tenant_id = item.tenant_id
        WHERE item.tenant_id = app.current_tenant_id()
          AND item.drama_id = requested_drama_id
          AND license.status IN ('scheduled', 'active')
          AND license.starts_at <= statement_timestamp()
          AND license.expires_at > statement_timestamp()
      )
      OR EXISTS (
        SELECT 1
        FROM public.tenant_public_drama_publications AS publication
        WHERE publication.tenant_id = app.current_tenant_id()
          AND publication.drama_id = requested_drama_id
          AND publication.status IN ('approved', 'published', 'unpublished')
      )
    )
$function$;

COMMENT ON FUNCTION app.tenant_has_drama_license(uuid) IS
  'Checks active legacy licenses or the tenant public-pool review/publication record.';

DROP TRIGGER IF EXISTS tenant_public_drama_publications_set_updated_at
  ON tenant_public_drama_publications;
CREATE TRIGGER tenant_public_drama_publications_set_updated_at
BEFORE UPDATE ON tenant_public_drama_publications
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_public_drama_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dramas AS drama
    WHERE drama.id = NEW.drama_id
      AND drama.owner_type = 'platform'
      AND drama.owner_tenant_id IS NULL
      AND drama.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Public pool target must be a platform drama'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.drama_id IS DISTINCT FROM OLD.drama_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Public pool publication identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Public pool publication version must advance by one'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_content_point_price_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_available boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Point price target identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'disabled' THEN
    RETURN NEW;
  END IF;

  IF NEW.target_type = 'drama' THEN
    SELECT EXISTS (
      SELECT 1 FROM dramas AS drama
      WHERE drama.id = NEW.target_id
        AND drama.status = 'published'
        AND drama.deleted_at IS NULL
        AND (
          (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
          OR (
            drama.owner_type = 'platform'
            AND (
              EXISTS (
                SELECT 1 FROM tenant_public_drama_publications AS publication
                WHERE publication.tenant_id = NEW.tenant_id
                  AND publication.drama_id = drama.id
                  AND publication.status IN ('approved', 'published', 'unpublished')
              )
              OR EXISTS (
                SELECT 1 FROM content_license_items AS item
                INNER JOIN content_licenses AS license
                  ON license.id = item.license_id AND license.tenant_id = item.tenant_id
                WHERE item.tenant_id = NEW.tenant_id AND item.drama_id = drama.id
                  AND license.status IN ('scheduled', 'active')
                  AND license.starts_at <= transaction_timestamp()
                  AND license.expires_at > transaction_timestamp()
              )
            )
          )
        )
    ) INTO target_available;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM episodes AS episode
      INNER JOIN dramas AS drama ON drama.id = episode.drama_id
      WHERE episode.id = NEW.target_id
        AND episode.status = 'published'
        AND episode.deleted_at IS NULL
        AND drama.status = 'published'
        AND drama.deleted_at IS NULL
        AND (
          (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
          OR (
            drama.owner_type = 'platform'
            AND (
              EXISTS (
                SELECT 1 FROM tenant_public_drama_publications AS publication
                WHERE publication.tenant_id = NEW.tenant_id
                  AND publication.drama_id = drama.id
                  AND publication.status IN ('approved', 'published', 'unpublished')
              )
              OR EXISTS (
                SELECT 1 FROM content_license_items AS item
                INNER JOIN content_licenses AS license
                  ON license.id = item.license_id AND license.tenant_id = item.tenant_id
                WHERE item.tenant_id = NEW.tenant_id AND item.drama_id = drama.id
                  AND license.status IN ('scheduled', 'active')
                  AND license.starts_at <= transaction_timestamp()
                  AND license.expires_at > transaction_timestamp()
              )
            )
          )
        )
    ) INTO target_available;
  END IF;

  IF NOT coalesce(target_available, false) THEN
    RAISE EXCEPTION 'Point price target is not currently published and licensed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_public_drama_publications_enforce
  ON tenant_public_drama_publications;
CREATE TRIGGER tenant_public_drama_publications_enforce
BEFORE INSERT OR UPDATE ON tenant_public_drama_publications
FOR EACH ROW EXECUTE FUNCTION app.enforce_public_drama_publication();

CREATE TABLE IF NOT EXISTS tenant_app_runtime_configs (
  tenant_id uuid PRIMARY KEY,
  supported_locales text[] NOT NULL DEFAULT ARRAY['en-US']::text[],
  allowed_countries text[] NOT NULL DEFAULT '{}'::text[],
  deep_link_host text,
  feature_flags_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  admob_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  store_products_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL,
  CONSTRAINT tenant_app_runtime_configs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_runtime_configs_locale_check CHECK (
    app.valid_locale_codes(supported_locales)
  ),
  CONSTRAINT tenant_app_runtime_configs_country_check CHECK (
    app.valid_country_codes(allowed_countries)
  ),
  CONSTRAINT tenant_app_runtime_configs_deep_link_check CHECK (
    deep_link_host IS NULL OR (
      char_length(deep_link_host) BETWEEN 4 AND 253
      AND deep_link_host = lower(deep_link_host)
      AND deep_link_host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    )
  ),
  CONSTRAINT tenant_app_runtime_configs_json_check CHECK (
    jsonb_typeof(feature_flags_json) = 'object'
    AND jsonb_typeof(admob_json) = 'object'
    AND jsonb_typeof(store_products_json) = 'object'
    AND pg_column_size(feature_flags_json) <= 8192
    AND pg_column_size(admob_json) <= 8192
    AND pg_column_size(store_products_json) <= 16384
  ),
  CONSTRAINT tenant_app_runtime_configs_version_check CHECK (version >= 0),
  CONSTRAINT tenant_app_runtime_configs_timestamp_check CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION app.enforce_tenant_app_runtime_config()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'App runtime config identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'App runtime config version must advance by one'
        USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_app_runtime_configs_enforce
  ON tenant_app_runtime_configs;
CREATE TRIGGER tenant_app_runtime_configs_enforce
BEFORE INSERT OR UPDATE ON tenant_app_runtime_configs
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_app_runtime_config();

DROP TRIGGER IF EXISTS tenant_app_runtime_configs_set_updated_at
  ON tenant_app_runtime_configs;
CREATE TRIGGER tenant_app_runtime_configs_set_updated_at
BEFORE UPDATE ON tenant_app_runtime_configs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS episode_media_tracks (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL,
  track_type text NOT NULL,
  locale text NOT NULL,
  label text NOT NULL,
  media_asset_id uuid NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT episode_media_tracks_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT episode_media_tracks_asset_fk FOREIGN KEY (media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT episode_media_tracks_unique UNIQUE (episode_id, track_type, locale),
  CONSTRAINT episode_media_tracks_type_check CHECK (
    track_type IN ('subtitle', 'dubbing')
  ),
  CONSTRAINT episode_media_tracks_locale_check CHECK (
    locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$'
  ),
  CONSTRAINT episode_media_tracks_label_check CHECK (
    char_length(btrim(label)) BETWEEN 1 AND 100
  ),
  CONSTRAINT episode_media_tracks_status_check CHECK (
    status IN ('active', 'disabled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS episode_media_tracks_default_unique_idx
  ON episode_media_tracks (episode_id, track_type)
  WHERE is_default AND status = 'active';
CREATE INDEX IF NOT EXISTS episode_media_tracks_episode_idx
  ON episode_media_tracks (episode_id, track_type, status, locale);

CREATE OR REPLACE FUNCTION app.enforce_episode_media_track()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  asset_mime text;
  asset_kind text;
BEGIN
  SELECT kind, mime_type INTO asset_kind, asset_mime
  FROM media_assets
  WHERE id = NEW.media_asset_id AND status = 'ready' AND deleted_at IS NULL;
  IF NOT FOUND OR asset_kind <> 'file' THEN
    RAISE EXCEPTION 'Episode media track requires a ready file asset'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.track_type = 'subtitle'
    AND asset_mime NOT IN ('text/vtt', 'application/x-subrip', 'application/ttml+xml')
  THEN
    RAISE EXCEPTION 'Subtitle track MIME type is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.track_type = 'dubbing'
    AND (asset_mime IS NULL OR asset_mime !~ '^audio/')
  THEN
    RAISE EXCEPTION 'Dubbing track MIME type is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS episode_media_tracks_enforce ON episode_media_tracks;
CREATE TRIGGER episode_media_tracks_enforce
BEFORE INSERT OR UPDATE OF media_asset_id, track_type, status
ON episode_media_tracks
FOR EACH ROW EXECUTE FUNCTION app.enforce_episode_media_track();

CREATE TABLE IF NOT EXISTS content_revenue_share_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  content_scope text NOT NULL,
  income_type text NOT NULL,
  headquarters_bps integer NOT NULL,
  tenant_bps integer NOT NULL,
  creator_bps integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL,
  CONSTRAINT content_revenue_share_policies_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_revenue_share_policies_unique UNIQUE (
    tenant_id, content_scope, income_type
  ),
  CONSTRAINT content_revenue_share_policies_scope_check CHECK (
    content_scope IN ('public', 'private')
  ),
  CONSTRAINT content_revenue_share_policies_income_check CHECK (
    income_type IN ('coin_unlock', 'content_ad', 'membership')
  ),
  CONSTRAINT content_revenue_share_policies_bps_check CHECK (
    headquarters_bps BETWEEN 0 AND 10000
    AND tenant_bps BETWEEN 0 AND 10000
    AND creator_bps BETWEEN 0 AND 10000
    AND headquarters_bps + tenant_bps + creator_bps = 10000
    AND (income_type <> 'membership' OR creator_bps = 0)
    AND (content_scope <> 'private' OR creator_bps = 0)
  ),
  CONSTRAINT content_revenue_share_policies_status_check CHECK (
    status IN ('active', 'disabled')
  ),
  CONSTRAINT content_revenue_share_policies_version_check CHECK (version >= 0),
  CONSTRAINT content_revenue_share_policies_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS content_revenue_share_policies_set_updated_at
  ON content_revenue_share_policies;
CREATE TRIGGER content_revenue_share_policies_set_updated_at
BEFORE UPDATE ON content_revenue_share_policies
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_revenue_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  episode_id uuid,
  creator_id_snapshot text,
  content_scope text NOT NULL,
  income_type text NOT NULL,
  currency text NOT NULL,
  gross_minor bigint NOT NULL,
  headquarters_minor bigint NOT NULL,
  tenant_minor bigint NOT NULL,
  creator_minor bigint NOT NULL,
  headquarters_bps_snapshot integer NOT NULL,
  tenant_bps_snapshot integer NOT NULL,
  creator_bps_snapshot integer NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  settlement_month date NOT NULL,
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  reversal_of_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT content_revenue_ledger_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_revenue_ledger_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_revenue_ledger_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_revenue_ledger_reversal_fk FOREIGN KEY (reversal_of_id)
    REFERENCES content_revenue_ledger (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_revenue_ledger_source_unique UNIQUE (
    tenant_id, source_type, source_id
  ),
  CONSTRAINT content_revenue_ledger_scope_check CHECK (
    content_scope IN ('public', 'private')
  ),
  CONSTRAINT content_revenue_ledger_income_check CHECK (
    income_type IN ('coin_unlock', 'content_ad', 'membership')
  ),
  CONSTRAINT content_revenue_ledger_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT content_revenue_ledger_amount_check CHECK (
    gross_minor >= 0
    AND headquarters_minor >= 0
    AND tenant_minor >= 0
    AND creator_minor >= 0
    AND headquarters_minor + tenant_minor + creator_minor = gross_minor
  ),
  CONSTRAINT content_revenue_ledger_snapshot_check CHECK (
    headquarters_bps_snapshot BETWEEN 0 AND 10000
    AND tenant_bps_snapshot BETWEEN 0 AND 10000
    AND creator_bps_snapshot BETWEEN 0 AND 10000
    AND headquarters_bps_snapshot + tenant_bps_snapshot
      + creator_bps_snapshot = 10000
    AND (content_scope = 'public') = (creator_id_snapshot IS NOT NULL)
    AND (income_type <> 'membership' OR creator_bps_snapshot = 0)
    AND (content_scope <> 'private' OR creator_bps_snapshot = 0)
  ),
  CONSTRAINT content_revenue_ledger_source_check CHECK (
    source_type IN ('apple_transaction', 'google_transaction', 'coin_unlock', 'ad_revenue')
    AND char_length(btrim(source_id)) BETWEEN 1 AND 500
  ),
  CONSTRAINT content_revenue_ledger_month_check CHECK (
    settlement_month = date_trunc('month', occurred_at AT TIME ZONE 'UTC')::date
  ),
  CONSTRAINT content_revenue_ledger_status_check CHECK (
    status IN ('pending', 'settled', 'reversed')
  ),
  CONSTRAINT content_revenue_ledger_reversal_check CHECK (
    (status = 'reversed' AND reversal_of_id IS NOT NULL)
    OR (status <> 'reversed' AND reversal_of_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS content_revenue_ledger_tenant_month_idx
  ON content_revenue_ledger (tenant_id, settlement_month, currency, status, id);
CREATE INDEX IF NOT EXISTS content_revenue_ledger_drama_idx
  ON content_revenue_ledger (drama_id, episode_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS content_revenue_ledger_creator_idx
  ON content_revenue_ledger (creator_id_snapshot, settlement_month, currency, id)
  WHERE creator_id_snapshot IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_content_revenue_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.drama_id IS DISTINCT FROM OLD.drama_id
      OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
      OR NEW.creator_id_snapshot IS DISTINCT FROM OLD.creator_id_snapshot
      OR NEW.content_scope IS DISTINCT FROM OLD.content_scope
      OR NEW.income_type IS DISTINCT FROM OLD.income_type
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.gross_minor IS DISTINCT FROM OLD.gross_minor
      OR NEW.headquarters_minor IS DISTINCT FROM OLD.headquarters_minor
      OR NEW.tenant_minor IS DISTINCT FROM OLD.tenant_minor
      OR NEW.creator_minor IS DISTINCT FROM OLD.creator_minor
      OR NEW.headquarters_bps_snapshot IS DISTINCT FROM OLD.headquarters_bps_snapshot
      OR NEW.tenant_bps_snapshot IS DISTINCT FROM OLD.tenant_bps_snapshot
      OR NEW.creator_bps_snapshot IS DISTINCT FROM OLD.creator_bps_snapshot
      OR NEW.source_type IS DISTINCT FROM OLD.source_type
      OR NEW.source_id IS DISTINCT FROM OLD.source_id
      OR NEW.settlement_month IS DISTINCT FROM OLD.settlement_month
      OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'Content revenue ledger facts are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('settled', 'reversed') THEN
      RAISE EXCEPTION 'Invalid content revenue ledger status transition'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_revenue_ledger_enforce ON content_revenue_ledger;
CREATE TRIGGER content_revenue_ledger_enforce
BEFORE UPDATE ON content_revenue_ledger
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_revenue_ledger();

ALTER TABLE tenant_public_drama_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_public_drama_publications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_public_drama_publications_tenant_access
  ON tenant_public_drama_publications;
CREATE POLICY tenant_public_drama_publications_tenant_access
  ON tenant_public_drama_publications FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_public_drama_publications_platform_access
  ON tenant_public_drama_publications;
CREATE POLICY tenant_public_drama_publications_platform_access
  ON tenant_public_drama_publications FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_app_runtime_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_app_runtime_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_app_runtime_configs_tenant_access
  ON tenant_app_runtime_configs;
CREATE POLICY tenant_app_runtime_configs_tenant_access
  ON tenant_app_runtime_configs FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_app_runtime_configs_platform_access
  ON tenant_app_runtime_configs;
CREATE POLICY tenant_app_runtime_configs_platform_access
  ON tenant_app_runtime_configs FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_revenue_share_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_revenue_share_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_revenue_share_policies_tenant_access
  ON content_revenue_share_policies;
CREATE POLICY content_revenue_share_policies_tenant_access
  ON content_revenue_share_policies FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_revenue_share_policies_platform_access
  ON content_revenue_share_policies;
CREATE POLICY content_revenue_share_policies_platform_access
  ON content_revenue_share_policies FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_revenue_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_revenue_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_revenue_ledger_tenant_access ON content_revenue_ledger;
CREATE POLICY content_revenue_ledger_tenant_access
  ON content_revenue_ledger FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_revenue_ledger_platform_access ON content_revenue_ledger;
CREATE POLICY content_revenue_ledger_platform_access
  ON content_revenue_ledger FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE episode_media_tracks ENABLE ROW LEVEL SECURITY;
ALTER TABLE episode_media_tracks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS episode_media_tracks_tenant_access ON episode_media_tracks;
CREATE POLICY episode_media_tracks_tenant_access
  ON episode_media_tracks FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM episodes AS episode
      INNER JOIN dramas AS drama ON drama.id = episode.drama_id
      WHERE episode.id = episode_media_tracks.episode_id
        AND (
          (drama.owner_type = 'tenant'
            AND drama.owner_tenant_id = app.current_tenant_id())
          OR (drama.owner_type = 'platform'
            AND app.tenant_has_drama_license(drama.id))
        )
    )
  );
DROP POLICY IF EXISTS episode_media_tracks_platform_access ON episode_media_tracks;
CREATE POLICY episode_media_tracks_platform_access
  ON episode_media_tracks FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMENT ON TABLE tenant_public_drama_publications IS
  'Tenant-owned review and publication state for the shared immutable public drama pool.';
COMMENT ON TABLE tenant_app_runtime_configs IS
  'Non-secret runtime branding, locale, region, AdMob placement and store product mapping.';
COMMENT ON TABLE content_revenue_ledger IS
  'Immutable per-content revenue and three-party share snapshots grouped by UTC settlement month.';
COMMENT ON TABLE episode_media_tracks IS
  'Generated or uploaded WebVTT/TTML subtitle and alternate dubbing tracks for one episode.';
COMMENT ON COLUMN dramas.public_release_locked_at IS
  'First public-pool publication lock. Released public content must be revised as a new drama.';
COMMENT ON COLUMN dramas.emergency_takedown_at IS
  'Platform emergency playback stop; tenant unpublishing is stored separately.';

REVOKE ALL ON FUNCTION app.valid_country_codes(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.valid_locale_codes(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_public_drama_publication() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_tenant_app_runtime_config() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_content_revenue_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_episode_media_track() FROM PUBLIC;

COMMIT;
