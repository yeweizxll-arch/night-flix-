BEGIN;

-- Shared public tracks stay read-only. Tenants may only write tracks of their
-- own private episodes, never tracks belonging to another tenant/public drama.
DROP POLICY IF EXISTS episode_media_tracks_tenant_insert ON episode_media_tracks;
CREATE POLICY episode_media_tracks_tenant_insert ON episode_media_tracks FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = episode_media_tracks.episode_id AND d.owner_type = 'tenant'
      AND d.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episode_media_tracks_tenant_update ON episode_media_tracks;
CREATE POLICY episode_media_tracks_tenant_update ON episode_media_tracks FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = episode_media_tracks.episode_id AND d.owner_type = 'tenant'
      AND d.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.id = episode_media_tracks.episode_id AND d.owner_type = 'tenant'
      AND d.owner_tenant_id = app.current_tenant_id()
  ));

-- An unavailable asset must not prevent an operator from disabling its track.
-- Rebinding, activation and inserts still require a ready file of the right MIME.
CREATE OR REPLACE FUNCTION app.enforce_episode_media_track()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  asset_mime text;
  asset_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'disabled' AND NOT NEW.is_default
    AND NEW.episode_id = OLD.episode_id AND NEW.media_asset_id = OLD.media_asset_id
    AND NEW.track_type = OLD.track_type
  THEN
    RETURN NEW;
  END IF;
  SELECT kind, mime_type INTO asset_kind, asset_mime FROM media_assets
    WHERE id = NEW.media_asset_id AND status = 'ready' AND deleted_at IS NULL;
  IF NOT FOUND OR asset_kind <> 'file' THEN
    RAISE EXCEPTION 'Episode media track requires a ready file asset' USING ERRCODE = '23514';
  END IF;
  IF NEW.track_type = 'subtitle'
    AND asset_mime NOT IN ('text/vtt', 'application/x-subrip', 'application/ttml+xml')
  THEN
    RAISE EXCEPTION 'Subtitle track MIME type is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.track_type = 'dubbing' AND (asset_mime IS NULL OR asset_mime !~ '^audio/') THEN
    RAISE EXCEPTION 'Dubbing track MIME type is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

COMMIT;
