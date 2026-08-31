BEGIN;

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS preview_media_asset_id uuid;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'episodes_preview_media_fk'
      AND conrelid = 'episodes'::regclass
  ) THEN
    ALTER TABLE episodes
      ADD CONSTRAINT episodes_preview_media_fk
      FOREIGN KEY (preview_media_asset_id)
      REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'episodes_preview_media_distinct_check'
      AND conrelid = 'episodes'::regclass
  ) THEN
    ALTER TABLE episodes
      ADD CONSTRAINT episodes_preview_media_distinct_check
      CHECK (
        preview_media_asset_id IS NULL
        OR preview_media_asset_id <> media_asset_id
      );
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS episodes_preview_media_idx
  ON episodes (preview_media_asset_id)
  WHERE preview_media_asset_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_episode_media_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  drama_owner_type text;
  drama_owner_tenant_id uuid;
  drama_status text;
  media_owner_type text;
  media_owner_tenant_id uuid;
  preview_owner_type text;
  preview_owner_tenant_id uuid;
  preview_kind text;
  preview_status text;
  preview_transcode_status text;
  preview_source_url text;
  preview_object_key text;
  preview_deleted_at timestamptz;
  preview_provider_id uuid;
  provider_owner_type text;
  provider_owner_tenant_id uuid;
  provider_kind text;
  provider_status text;
BEGIN
  SELECT owner_type, owner_tenant_id, status
    INTO drama_owner_type, drama_owner_tenant_id, drama_status
  FROM dramas WHERE id = NEW.drama_id;

  IF TG_OP = 'UPDATE'
    AND (
      NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id
      OR NEW.preview_media_asset_id IS DISTINCT FROM OLD.preview_media_asset_id
    )
    AND NOT (
      (drama_owner_type = 'tenant' AND drama_status IN ('draft', 'rejected'))
      OR
      (drama_owner_type = 'platform'
        AND drama_status IN ('draft', 'rejected', 'unpublished'))
    ) THEN
    RAISE EXCEPTION 'Episode media cannot change after submission or publication'
      USING ERRCODE = '23514';
  END IF;

  SELECT owner_type, owner_tenant_id
    INTO media_owner_type, media_owner_tenant_id
  FROM media_assets WHERE id = NEW.media_asset_id;

  IF drama_owner_type IS NULL OR media_owner_type IS NULL
    OR NOT app.scope_can_reference(
      drama_owner_type, drama_owner_tenant_id, media_owner_type, media_owner_tenant_id
    ) THEN
    RAISE EXCEPTION 'Episode media is outside the drama scope' USING ERRCODE = '23514';
  END IF;

  IF NEW.preview_media_asset_id IS NOT NULL THEN
    IF NEW.preview_media_asset_id = NEW.media_asset_id THEN
      RAISE EXCEPTION 'Episode preview media must differ from full media' USING ERRCODE = '23514';
    END IF;

    SELECT
      owner_type, owner_tenant_id, kind, status, transcode_status,
      source_url, object_key, deleted_at, storage_provider_id
      INTO
        preview_owner_type, preview_owner_tenant_id, preview_kind, preview_status,
        preview_transcode_status, preview_source_url, preview_object_key,
        preview_deleted_at, preview_provider_id
    FROM media_assets WHERE id = NEW.preview_media_asset_id;

    IF NOT FOUND
      OR preview_owner_type IS DISTINCT FROM drama_owner_type
      OR preview_owner_tenant_id IS DISTINCT FROM drama_owner_tenant_id
      OR preview_kind IS DISTINCT FROM 'video'
      OR preview_status IS DISTINCT FROM 'ready'
      OR preview_transcode_status NOT IN ('not_required', 'ready')
      OR preview_deleted_at IS NOT NULL
      OR preview_source_url IS NOT NULL
      OR preview_object_key IS NULL
      OR preview_provider_id IS NULL THEN
      RAISE EXCEPTION 'Episode preview media is not a ready internal video in the drama scope'
        USING ERRCODE = '23514';
    END IF;

    SELECT owner_type, owner_tenant_id, provider, status
      INTO provider_owner_type, provider_owner_tenant_id, provider_kind, provider_status
    FROM storage_providers WHERE id = preview_provider_id;

    IF NOT FOUND
      OR provider_kind IS DISTINCT FROM 's3'
      OR provider_status IS DISTINCT FROM 'active'
      OR NOT (
        (drama_owner_type = 'platform'
          AND provider_owner_type = 'platform'
          AND provider_owner_tenant_id IS NULL)
        OR
        (drama_owner_type = 'tenant' AND (
          (provider_owner_type = 'platform' AND provider_owner_tenant_id IS NULL)
          OR
          (provider_owner_type = 'tenant'
            AND provider_owner_tenant_id IS NOT DISTINCT FROM drama_owner_tenant_id)
        ))
      ) THEN
      RAISE EXCEPTION 'Episode preview storage provider is unavailable for the drama scope'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS episodes_enforce_media_scope ON episodes;
CREATE TRIGGER episodes_enforce_media_scope
BEFORE INSERT OR UPDATE OF drama_id, media_asset_id, preview_media_asset_id ON episodes
FOR EACH ROW EXECUTE FUNCTION app.enforce_episode_media_scope();

CREATE OR REPLACE FUNCTION app.tenant_can_access_media(requested_asset_id uuid)
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
        FROM public.dramas AS drama
        WHERE drama.owner_type = 'platform'
          AND drama.cover_file_id = requested_asset_id
          AND app.tenant_has_drama_license(drama.id)
      )
      OR EXISTS (
        SELECT 1
        FROM public.episodes AS episode
        INNER JOIN public.dramas AS drama ON drama.id = episode.drama_id
        WHERE drama.owner_type = 'platform'
          AND (
            episode.media_asset_id = requested_asset_id
            OR episode.preview_media_asset_id = requested_asset_id
          )
          AND app.tenant_has_drama_license(drama.id)
      )
    )
$function$;

COMMENT ON COLUMN episodes.preview_media_asset_id IS
  'Optional dedicated clipped preview video. It is never allowed to reference the full episode media.';
COMMENT ON FUNCTION app.tenant_can_access_media(uuid) IS
  'Allows platform cover, full episode, and dedicated preview media reads only for dramas licensed to the current tenant.';

REVOKE ALL ON FUNCTION app.enforce_episode_media_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_can_access_media(uuid) TO PUBLIC;

COMMIT;
