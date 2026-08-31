BEGIN;

CREATE TABLE IF NOT EXISTS customer_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  username citext NOT NULL,
  email citext,
  phone text,
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  disabled_at timestamptz,
  disabled_by uuid,
  disable_reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_accounts_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_accounts_username_unique UNIQUE (tenant_id, username),
  CONSTRAINT customer_accounts_username_check CHECK (
    username::text = lower(username::text)
    AND username::text ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  ),
  CONSTRAINT customer_accounts_email_check CHECK (
    email IS NULL OR (
      email::text = lower(email::text)
      AND char_length(email::text) BETWEEN 3 AND 320
      AND email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  CONSTRAINT customer_accounts_phone_check CHECK (
    phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT customer_accounts_password_check CHECK (
    char_length(password_hash) BETWEEN 20 AND 512
  ),
  CONSTRAINT customer_accounts_email_verification_check CHECK (
    email IS NOT NULL OR email_verified_at IS NULL
  ),
  CONSTRAINT customer_accounts_phone_verification_check CHECK (
    phone IS NOT NULL OR phone_verified_at IS NULL
  ),
  CONSTRAINT customer_accounts_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT customer_accounts_disable_check CHECK (
    (
      status = 'active'
      AND disabled_at IS NULL AND disabled_by IS NULL AND disable_reason IS NULL
    )
    OR (
      status = 'disabled'
      AND disabled_at IS NOT NULL AND disabled_by IS NOT NULL
      AND disable_reason IS NOT NULL
      AND char_length(btrim(disable_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT customer_accounts_version_check CHECK (version >= 0),
  CONSTRAINT customer_accounts_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_tenant_email_unique_idx
  ON customer_accounts (tenant_id, email)
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_tenant_phone_unique_idx
  ON customer_accounts (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_accounts_tenant_status_idx
  ON customer_accounts (tenant_id, status, created_at DESC);

DROP TRIGGER IF EXISTS customer_accounts_set_updated_at ON customer_accounts;
CREATE TRIGGER customer_accounts_set_updated_at
BEFORE UPDATE ON customer_accounts
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_otp_challenges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid,
  purpose text NOT NULL,
  channel text NOT NULL,
  destination_hash text NOT NULL,
  code_hash text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  universal_code_used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_otp_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_otp_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_otp_purpose_check CHECK (
    purpose IN (
      'verify_email', 'verify_phone', 'login', 'password_reset'
    )
  ),
  CONSTRAINT customer_otp_channel_check CHECK (channel IN ('email', 'phone')),
  CONSTRAINT customer_otp_purpose_channel_check CHECK (
    purpose NOT IN ('verify_email', 'verify_phone')
    OR purpose = 'verify_' || channel
  ),
  CONSTRAINT customer_otp_destination_hash_check CHECK (
    destination_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT customer_otp_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_otp_key_version_check CHECK (key_version > 0),
  CONSTRAINT customer_otp_attempts_check CHECK (
    max_attempts BETWEEN 1 AND 20
    AND attempts BETWEEN 0 AND max_attempts
  ),
  CONSTRAINT customer_otp_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT customer_otp_consumed_check CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  ),
  CONSTRAINT customer_otp_universal_check CHECK (
    NOT universal_code_used OR consumed_at IS NOT NULL
  ),
  CONSTRAINT customer_otp_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS customer_otp_active_destination_idx
  ON customer_otp_challenges (
    tenant_id, purpose, channel, destination_hash, expires_at DESC
  )
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_otp_expiry_idx
  ON customer_otp_challenges (expires_at, id)
  WHERE consumed_at IS NULL;

DROP TRIGGER IF EXISTS customer_otp_set_updated_at ON customer_otp_challenges;
CREATE TRIGGER customer_otp_set_updated_at
BEFORE UPDATE ON customer_otp_challenges
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device_token_hash text NOT NULL,
  platform text NOT NULL,
  label text,
  status text NOT NULL DEFAULT 'active',
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_devices_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_devices_tenant_account_id_unique
    UNIQUE (tenant_id, account_id, id),
  CONSTRAINT customer_devices_token_unique UNIQUE (device_token_hash),
  CONSTRAINT customer_devices_token_hash_check CHECK (
    char_length(device_token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT customer_devices_platform_check CHECK (
    platform IN ('web', 'h5', 'android', 'ios')
  ),
  CONSTRAINT customer_devices_label_check CHECK (
    label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 100
  ),
  CONSTRAINT customer_devices_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT customer_devices_revocation_check CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (
      status = 'revoked' AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND char_length(btrim(revoke_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT customer_devices_last_seen_check CHECK (last_seen_at >= created_at),
  CONSTRAINT customer_devices_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS customer_devices_account_active_idx
  ON customer_devices (tenant_id, account_id, last_seen_at, id)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS customer_devices_set_updated_at ON customer_devices;
CREATE TRIGGER customer_devices_set_updated_at
BEFORE UPDATE ON customer_devices
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_sessions (
  id uuid PRIMARY KEY,
  session_family_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device_id uuid NOT NULL,
  access_token_hash text NOT NULL,
  refresh_token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_ip inet,
  user_agent_hash text,
  rotation_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_sessions_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_sessions_device_fk FOREIGN KEY (
    tenant_id, account_id, device_id
  ) REFERENCES customer_devices (tenant_id, account_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_sessions_access_token_unique UNIQUE (access_token_hash),
  CONSTRAINT customer_sessions_refresh_token_unique UNIQUE (refresh_token_hash),
  CONSTRAINT customer_sessions_family_check CHECK (
    session_family_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT customer_sessions_access_hash_check CHECK (
    char_length(access_token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT customer_sessions_refresh_hash_check CHECK (
    char_length(refresh_token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT customer_sessions_hashes_differ_check CHECK (
    access_token_hash <> refresh_token_hash
  ),
  CONSTRAINT customer_sessions_expiry_check CHECK (
    access_expires_at > issued_at
    AND refresh_expires_at >= access_expires_at
    AND absolute_expires_at >= refresh_expires_at
    AND absolute_expires_at <= issued_at + interval '30 days'
  ),
  CONSTRAINT customer_sessions_last_seen_check CHECK (last_seen_at >= issued_at),
  CONSTRAINT customer_sessions_user_agent_check CHECK (
    user_agent_hash IS NULL OR char_length(user_agent_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT customer_sessions_rotation_check CHECK (rotation_count >= 0),
  CONSTRAINT customer_sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (
      revoked_at IS NOT NULL AND revoked_at >= issued_at
      AND revoked_reason IS NOT NULL
      AND char_length(btrim(revoked_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT customer_sessions_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS customer_sessions_account_active_idx
  ON customer_sessions (tenant_id, account_id, last_seen_at, id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_sessions_device_active_idx
  ON customer_sessions (tenant_id, account_id, device_id, last_seen_at, id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_sessions_expiry_idx
  ON customer_sessions (refresh_expires_at, absolute_expires_at)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS customer_sessions_set_updated_at ON customer_sessions;
CREATE TRIGGER customer_sessions_set_updated_at
BEFORE UPDATE ON customer_sessions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_refresh_token_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  session_family_id uuid NOT NULL,
  token_hash text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_refresh_history_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_refresh_history_session_fk FOREIGN KEY (session_id)
    REFERENCES customer_sessions (id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_refresh_history_token_unique UNIQUE (token_hash),
  CONSTRAINT customer_refresh_history_hash_check CHECK (
    char_length(token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT customer_refresh_history_expiry_check CHECK (expires_at > used_at)
);

CREATE INDEX IF NOT EXISTS customer_refresh_history_family_idx
  ON customer_refresh_token_history (tenant_id, session_family_id, used_at DESC);

CREATE INDEX IF NOT EXISTS customer_refresh_history_expiry_idx
  ON customer_refresh_token_history (expires_at, id);

DROP TRIGGER IF EXISTS customer_refresh_history_prevent_update
  ON customer_refresh_token_history;
CREATE TRIGGER customer_refresh_history_prevent_update
BEFORE UPDATE OR DELETE ON customer_refresh_token_history
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS watch_progress (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  position_seconds integer NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT watch_progress_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT watch_progress_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT watch_progress_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT watch_progress_unique UNIQUE (tenant_id, account_id, episode_id),
  CONSTRAINT watch_progress_position_check CHECK (position_seconds >= 0),
  CONSTRAINT watch_progress_version_check CHECK (version >= 0),
  CONSTRAINT watch_progress_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS watch_progress_history_idx
  ON watch_progress (tenant_id, account_id, updated_at DESC, id DESC);

DROP TRIGGER IF EXISTS watch_progress_set_updated_at ON watch_progress;
CREATE TRIGGER watch_progress_set_updated_at
BEFORE UPDATE ON watch_progress
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_favorites (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_favorites_pk PRIMARY KEY (tenant_id, account_id, drama_id),
  CONSTRAINT customer_favorites_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_favorites_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customer_favorites_history_idx
  ON customer_favorites (tenant_id, account_id, created_at DESC, drama_id);

CREATE OR REPLACE FUNCTION app.enforce_watch_progress_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_duration integer;
BEGIN
  SELECT episode.duration_seconds
    INTO target_duration
  FROM episodes AS episode
  INNER JOIN dramas AS drama ON drama.id = episode.drama_id
  WHERE episode.id = NEW.episode_id
    AND episode.drama_id = NEW.drama_id
    AND episode.status = 'published'
    AND episode.deleted_at IS NULL
    AND drama.status = 'published'
    AND drama.deleted_at IS NULL;

  IF target_duration IS NULL OR NEW.position_seconds > target_duration THEN
    RAISE EXCEPTION 'Watch target is unavailable or position exceeds duration'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS watch_progress_enforce_target ON watch_progress;
CREATE TRIGGER watch_progress_enforce_target
BEFORE INSERT OR UPDATE OF drama_id, episode_id, position_seconds
ON watch_progress
FOR EACH ROW EXECUTE FUNCTION app.enforce_watch_progress_target();

CREATE OR REPLACE FUNCTION app.enforce_customer_favorite_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = NEW.drama_id
      AND dramas.status = 'published'
      AND dramas.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Favorite drama is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_favorites_enforce_target ON customer_favorites;
CREATE TRIGGER customer_favorites_enforce_target
BEFORE INSERT OR UPDATE OF drama_id ON customer_favorites
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_favorite_target();

ALTER TABLE customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_accounts_tenant_isolation ON customer_accounts;
CREATE POLICY customer_accounts_tenant_isolation ON customer_accounts
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_accounts_platform_access ON customer_accounts;
CREATE POLICY customer_accounts_platform_access ON customer_accounts
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_otp_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_otp_tenant_isolation ON customer_otp_challenges;
CREATE POLICY customer_otp_tenant_isolation ON customer_otp_challenges
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_otp_platform_access ON customer_otp_challenges;
CREATE POLICY customer_otp_platform_access ON customer_otp_challenges
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_devices_tenant_isolation ON customer_devices;
CREATE POLICY customer_devices_tenant_isolation ON customer_devices
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_devices_platform_access ON customer_devices;
CREATE POLICY customer_devices_platform_access ON customer_devices
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_sessions_tenant_isolation ON customer_sessions;
CREATE POLICY customer_sessions_tenant_isolation ON customer_sessions
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_sessions_platform_access ON customer_sessions;
CREATE POLICY customer_sessions_platform_access ON customer_sessions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_refresh_token_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_refresh_token_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_refresh_history_tenant_isolation
  ON customer_refresh_token_history;
CREATE POLICY customer_refresh_history_tenant_isolation
  ON customer_refresh_token_history
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_refresh_history_platform_access
  ON customer_refresh_token_history;
CREATE POLICY customer_refresh_history_platform_access
  ON customer_refresh_token_history
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE watch_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_progress FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watch_progress_tenant_isolation ON watch_progress;
CREATE POLICY watch_progress_tenant_isolation ON watch_progress
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS watch_progress_platform_access ON watch_progress;
CREATE POLICY watch_progress_platform_access ON watch_progress
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_favorites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_favorites_tenant_isolation ON customer_favorites;
CREATE POLICY customer_favorites_tenant_isolation ON customer_favorites
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_favorites_platform_access ON customer_favorites;
CREATE POLICY customer_favorites_platform_access ON customer_favorites
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.enforce_watch_progress_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_customer_favorite_target() FROM PUBLIC;

COMMIT;
