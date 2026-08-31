BEGIN;

CREATE TABLE IF NOT EXISTS tenant_app_build_profiles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE,
  app_name text NOT NULL,
  android_application_id text NOT NULL,
  ios_bundle_id text NOT NULL,
  icon_media_asset_id uuid NOT NULL,
  splash_media_asset_id uuid,
  h5_domain_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT tenant_app_build_profiles_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_profiles_icon_fk FOREIGN KEY (icon_media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_profiles_splash_fk FOREIGN KEY (splash_media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_profiles_domain_fk FOREIGN KEY (h5_domain_id)
    REFERENCES tenant_domains (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_profiles_name_check CHECK (
    char_length(btrim(app_name)) BETWEEN 2 AND 50
    AND app_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT tenant_app_build_profiles_android_id_check CHECK (
    char_length(android_application_id) BETWEEN 3 AND 150
    AND android_application_id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  CONSTRAINT tenant_app_build_profiles_ios_id_check CHECK (
    char_length(ios_bundle_id) BETWEEN 3 AND 200
    AND ios_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$'
  ),
  CONSTRAINT tenant_app_build_profiles_version_check CHECK (version >= 0),
  CONSTRAINT tenant_app_build_profiles_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_app_build_profiles_android_id_unique_idx
  ON tenant_app_build_profiles (lower(android_application_id));
CREATE UNIQUE INDEX IF NOT EXISTS tenant_app_build_profiles_ios_id_unique_idx
  ON tenant_app_build_profiles (lower(ios_bundle_id));

CREATE OR REPLACE FUNCTION app.enforce_tenant_app_build_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  selected_media uuid;
  selected_mime text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'App build profile identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'App build profile version must advance by one'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM tenants AS tenant
    WHERE tenant.id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'App build profile tenant does not exist' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM tenant_domains AS domain
    WHERE domain.id = NEW.h5_domain_id
      AND domain.tenant_id = NEW.tenant_id
      AND domain.verified_at IS NOT NULL
      AND domain.disabled_at IS NULL
      AND domain.tls_status = 'active'
  ) THEN
    RAISE EXCEPTION 'App build profile requires a verified active tenant domain'
      USING ERRCODE = '23514';
  END IF;

  FOREACH selected_media IN ARRAY ARRAY[NEW.icon_media_asset_id, NEW.splash_media_asset_id]
  LOOP
    IF selected_media IS NULL THEN CONTINUE; END IF;
    SELECT media.mime_type INTO selected_mime
    FROM media_assets AS media
    INNER JOIN storage_providers AS provider ON provider.id = media.storage_provider_id
    WHERE media.id = selected_media
      AND media.owner_type = 'tenant'
      AND media.owner_tenant_id = NEW.tenant_id
      AND media.kind = 'image'
      AND media.status = 'ready'
      AND media.transcode_status IN ('ready', 'not_required')
      AND media.object_key IS NOT NULL
      AND media.source_url IS NULL
      AND media.checksum IS NOT NULL
      AND media.deleted_at IS NULL
      AND (
        (
          selected_media = NEW.icon_media_asset_id
          AND media.metadata_json @> '{"appBuildAsset":{"purpose":"app_icon","width":1024,"height":1024,"hasAlpha":false}}'::jsonb
        ) OR (
          selected_media = NEW.splash_media_asset_id
          AND media.metadata_json @> '{"appBuildAsset":{"purpose":"launch_image"}}'::jsonb
        )
      )
      AND provider.status = 'active';
    IF selected_mime IS NULL THEN
      RAISE EXCEPTION 'App build media must be a ready internal tenant image'
        USING ERRCODE = '23514';
    END IF;
    IF selected_media = NEW.icon_media_asset_id AND selected_mime <> 'image/png' THEN
      RAISE EXCEPTION 'App icon must be a PNG image' USING ERRCODE = '23514';
    END IF;
    IF selected_media = NEW.splash_media_asset_id
      AND selected_mime NOT IN ('image/png', 'image/jpeg', 'image/webp')
    THEN
      RAISE EXCEPTION 'App splash image format is unsupported' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_app_build_profiles_enforce
  ON tenant_app_build_profiles;
CREATE TRIGGER tenant_app_build_profiles_enforce
BEFORE INSERT OR UPDATE ON tenant_app_build_profiles
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_app_build_profile();

DROP TRIGGER IF EXISTS tenant_app_build_profiles_set_updated_at
  ON tenant_app_build_profiles;
CREATE TRIGGER tenant_app_build_profiles_set_updated_at
BEFORE UPDATE ON tenant_app_build_profiles
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_app_build_profiles_prevent_delete
  ON tenant_app_build_profiles;
CREATE TRIGGER tenant_app_build_profiles_prevent_delete
BEFORE DELETE ON tenant_app_build_profiles
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS tenant_app_build_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  profile_version integer NOT NULL,
  target text NOT NULL,
  release_channel text NOT NULL DEFAULT 'internal_test',
  status text NOT NULL DEFAULT 'queued',
  snapshot_json jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 2,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  completed_at timestamptz,
  artifact_storage_provider_id uuid,
  artifact_object_key text,
  artifact_filename text,
  artifact_content_type text,
  artifact_size_bytes bigint,
  artifact_checksum text,
  failure_code text,
  version integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT tenant_app_build_jobs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_jobs_profile_fk FOREIGN KEY (profile_id)
    REFERENCES tenant_app_build_profiles (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_jobs_artifact_provider_fk
    FOREIGN KEY (artifact_storage_provider_id)
    REFERENCES storage_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_app_build_jobs_target_check CHECK (
    target IN ('android_debug', 'ios_simulator')
  ),
  CONSTRAINT tenant_app_build_jobs_channel_check CHECK (
    release_channel = 'internal_test'
  ),
  CONSTRAINT tenant_app_build_jobs_status_check CHECK (
    status IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT tenant_app_build_jobs_snapshot_check CHECK (
    jsonb_typeof(snapshot_json) = 'object' AND pg_column_size(snapshot_json) <= 32768
  ),
  CONSTRAINT tenant_app_build_jobs_attempt_check CHECK (
    attempts BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 5
  ),
  CONSTRAINT tenant_app_build_jobs_lock_check CHECK (
    (status <> 'processing') OR (
      locked_at IS NOT NULL AND locked_by IS NOT NULL
      AND char_length(locked_by) BETWEEN 1 AND 200
      AND attempts > 0 AND started_at IS NOT NULL
    )
  ),
  CONSTRAINT tenant_app_build_jobs_completion_check CHECK (
    (status IN ('queued', 'processing') AND completed_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
  ),
  CONSTRAINT tenant_app_build_jobs_artifact_check CHECK (
    (
      status = 'succeeded'
      AND artifact_storage_provider_id IS NOT NULL
      AND artifact_object_key IS NOT NULL
      AND artifact_filename IS NOT NULL
      AND artifact_content_type IN (
        'application/vnd.android.package-archive', 'application/zip'
      )
      AND artifact_size_bytes > 0
      AND artifact_checksum ~ '^sha256:[0-9a-f]{64}$'
      AND failure_code IS NULL
    ) OR (
      status <> 'succeeded'
      AND artifact_storage_provider_id IS NULL
      AND artifact_object_key IS NULL
      AND artifact_filename IS NULL
      AND artifact_content_type IS NULL
      AND artifact_size_bytes IS NULL
      AND artifact_checksum IS NULL
    )
  ),
  CONSTRAINT tenant_app_build_jobs_failure_check CHECK (
    (status = 'failed' AND failure_code IN (
      'builder_unavailable', 'asset_unavailable', 'build_failed',
      'artifact_upload_failed', 'job_timed_out'
    )) OR (status <> 'failed' AND failure_code IS NULL)
  ),
  CONSTRAINT tenant_app_build_jobs_version_check CHECK (version >= 0),
  CONSTRAINT tenant_app_build_jobs_timestamp_check CHECK (
    updated_at >= created_at
    AND (started_at IS NULL OR started_at >= created_at)
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

CREATE INDEX IF NOT EXISTS tenant_app_build_jobs_due_idx
  ON tenant_app_build_jobs (available_at, created_at, id)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS tenant_app_build_jobs_tenant_idx
  ON tenant_app_build_jobs (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tenant_app_build_jobs_processing_idx
  ON tenant_app_build_jobs (locked_at, id) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS app_build_worker_heartbeats (
  worker_id text PRIMARY KEY,
  artifact_storage_provider_id uuid NOT NULL
    REFERENCES storage_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  capabilities text[] NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT app_build_worker_heartbeats_id_check CHECK (
    char_length(worker_id) BETWEEN 1 AND 200
    AND worker_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT app_build_worker_heartbeats_capabilities_check CHECK (
    capabilities = ARRAY['android_debug']::text[]
    OR capabilities = ARRAY['ios_simulator']::text[]
    OR capabilities = ARRAY['android_debug', 'ios_simulator']::text[]
  ),
  CONSTRAINT app_build_worker_heartbeats_time_check CHECK (last_seen_at >= started_at)
);

CREATE INDEX IF NOT EXISTS app_build_worker_heartbeats_seen_idx
  ON app_build_worker_heartbeats (last_seen_at DESC);

CREATE OR REPLACE FUNCTION app.enforce_tenant_app_build_job()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 OR NEW.version <> 0 THEN
      RAISE EXCEPTION 'App build jobs must begin queued' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM tenant_app_build_profiles AS profile
      WHERE profile.id = NEW.profile_id AND profile.tenant_id = NEW.tenant_id
        AND profile.version = NEW.profile_version
    ) THEN
      RAISE EXCEPTION 'App build job snapshot profile version is stale'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.profile_version IS DISTINCT FROM OLD.profile_version
    OR NEW.target IS DISTINCT FROM OLD.target
    OR NEW.release_channel IS DISTINCT FROM OLD.release_channel
    OR NEW.snapshot_json IS DISTINCT FROM OLD.snapshot_json
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'App build job request facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'App build job version must advance by one' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'queued' AND NEW.status IN ('processing', 'cancelled'))
    OR (OLD.status = 'processing' AND NEW.status IN ('queued', 'succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'App build job status transition is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM storage_providers AS provider
    WHERE provider.id = NEW.artifact_storage_provider_id
      AND provider.owner_type = 'platform'
      AND provider.owner_tenant_id IS NULL
      AND provider.status = 'active'
  ) THEN
    RAISE EXCEPTION 'App build artifact provider must be an active platform provider'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_app_build_jobs_enforce
  ON tenant_app_build_jobs;
CREATE TRIGGER tenant_app_build_jobs_enforce
BEFORE INSERT OR UPDATE ON tenant_app_build_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_app_build_job();

DROP TRIGGER IF EXISTS tenant_app_build_jobs_set_updated_at
  ON tenant_app_build_jobs;
CREATE TRIGGER tenant_app_build_jobs_set_updated_at
BEFORE UPDATE ON tenant_app_build_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_app_build_jobs_prevent_delete
  ON tenant_app_build_jobs;
CREATE TRIGGER tenant_app_build_jobs_prevent_delete
BEFORE DELETE ON tenant_app_build_jobs
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

ALTER TABLE tenant_app_build_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_app_build_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_app_build_profiles_platform_access
  ON tenant_app_build_profiles;
CREATE POLICY tenant_app_build_profiles_platform_access
  ON tenant_app_build_profiles FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_app_build_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_app_build_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_app_build_jobs_platform_access
  ON tenant_app_build_jobs;
CREATE POLICY tenant_app_build_jobs_platform_access
  ON tenant_app_build_jobs FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE app_build_worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_build_worker_heartbeats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_build_worker_heartbeats_platform_access
  ON app_build_worker_heartbeats;
CREATE POLICY app_build_worker_heartbeats_platform_access
  ON app_build_worker_heartbeats FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMENT ON TABLE tenant_app_build_profiles IS
  'Platform-managed, tenant-scoped white-label mobile build inputs. No signing secrets.';
COMMENT ON TABLE tenant_app_build_jobs IS
  'Immutable internal-test Android debug or unsigned iOS simulator build requests.';
COMMENT ON TABLE app_build_worker_heartbeats IS
  'Short-lived platform-only native builder capability advertisements.';

COMMIT;
