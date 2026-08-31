BEGIN;

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  session_family_id uuid NOT NULL,
  tenant_id uuid,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  device_id text,
  access_token_hash text NOT NULL,
  refresh_token_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_ip inet,
  user_agent_hash text,
  revoked_at timestamptz,
  revoked_reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT auth_sessions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT auth_sessions_access_token_unique UNIQUE (access_token_hash),
  CONSTRAINT auth_sessions_refresh_token_unique UNIQUE (refresh_token_hash),
  CONSTRAINT auth_sessions_scope_check CHECK (
    (subject_type = 'platform_staff' AND tenant_id IS NULL)
    OR (subject_type IN ('tenant_staff', 'user') AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT auth_sessions_device_id_check CHECK (
    device_id IS NULL OR char_length(device_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT auth_sessions_access_token_hash_check CHECK (
    char_length(access_token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT auth_sessions_refresh_token_hash_check CHECK (
    char_length(refresh_token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT auth_sessions_token_hashes_differ_check CHECK (
    access_token_hash <> refresh_token_hash
  ),
  CONSTRAINT auth_sessions_family_id_check CHECK (
    session_family_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  CONSTRAINT auth_sessions_expiry_check CHECK (
    access_expires_at > issued_at
    AND refresh_expires_at >= access_expires_at
    AND absolute_expires_at >= refresh_expires_at
    AND absolute_expires_at <= issued_at + interval '30 days'
  ),
  CONSTRAINT auth_sessions_last_seen_check CHECK (last_seen_at >= issued_at),
  CONSTRAINT auth_sessions_user_agent_hash_check CHECK (
    user_agent_hash IS NULL OR char_length(user_agent_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT auth_sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (
      revoked_at IS NOT NULL
      AND revoked_at >= issued_at
      AND revoked_reason IS NOT NULL
      AND char_length(btrim(revoked_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT auth_sessions_version_check CHECK (version >= 0),
  CONSTRAINT auth_sessions_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS auth_sessions_subject_active_idx
  ON auth_sessions (tenant_id, subject_type, subject_id, issued_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_family_active_idx
  ON auth_sessions (session_family_id, issued_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_tenant_device_active_idx
  ON auth_sessions (tenant_id, subject_id, device_id, last_seen_at)
  WHERE revoked_at IS NULL AND device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_access_expiry_idx
  ON auth_sessions (access_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_refresh_expiry_idx
  ON auth_sessions (refresh_expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_absolute_expiry_idx
  ON auth_sessions (absolute_expires_at)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS auth_sessions_set_updated_at ON auth_sessions;
CREATE TRIGGER auth_sessions_set_updated_at
BEFORE UPDATE ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS auth_refresh_token_history (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  session_id uuid NOT NULL,
  session_family_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  token_hash text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  used_ip inet,
  used_user_agent_hash text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT auth_refresh_history_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT auth_refresh_history_session_fk FOREIGN KEY (session_id)
    REFERENCES auth_sessions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT auth_refresh_history_token_unique UNIQUE (token_hash),
  CONSTRAINT auth_refresh_history_scope_check CHECK (
    (subject_type = 'platform_staff' AND tenant_id IS NULL)
    OR (subject_type IN ('tenant_staff', 'user') AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT auth_refresh_history_hash_check CHECK (
    char_length(token_hash) BETWEEN 32 AND 512
  ),
  CONSTRAINT auth_refresh_history_expiry_check CHECK (expires_at > used_at),
  CONSTRAINT auth_refresh_history_user_agent_check CHECK (
    used_user_agent_hash IS NULL
    OR char_length(used_user_agent_hash) BETWEEN 32 AND 512
  )
);

CREATE INDEX IF NOT EXISTS auth_refresh_history_family_idx
  ON auth_refresh_token_history (session_family_id, used_at DESC);

CREATE INDEX IF NOT EXISTS auth_refresh_history_expiry_idx
  ON auth_refresh_token_history (expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  actor_type text NOT NULL,
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  before_json jsonb,
  after_json jsonb,
  ip inet,
  user_agent text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT audit_logs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT audit_logs_scope_check CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT audit_logs_actor_type_check CHECK (
    actor_type IN ('system', 'platform_staff', 'tenant_staff', 'user')
  ),
  CONSTRAINT audit_logs_actor_id_check CHECK (
    (actor_type = 'system' AND actor_id IS NULL)
    OR (actor_type <> 'system' AND actor_id IS NOT NULL)
  ),
  CONSTRAINT audit_logs_action_check CHECK (
    char_length(action) BETWEEN 3 AND 200
    AND action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
  ),
  CONSTRAINT audit_logs_resource_type_check CHECK (
    resource_type ~ '^[a-z][a-z0-9_]{1,99}$'
  ),
  CONSTRAINT audit_logs_user_agent_check CHECK (
    user_agent IS NULL OR char_length(user_agent) <= 2000
  ),
  CONSTRAINT audit_logs_request_id_check CHECK (char_length(request_id) BETWEEN 8 AND 128)
);

CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_idx
  ON audit_logs (tenant_id, created_at DESC, id)
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS audit_logs_platform_created_idx
  ON audit_logs (created_at DESC, id)
  WHERE scope_type = 'platform';

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
  ON audit_logs (actor_type, actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_resource_idx
  ON audit_logs (resource_type, resource_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_logs_request_id_idx
  ON audit_logs (request_id);

DROP TRIGGER IF EXISTS audit_logs_prevent_update ON audit_logs;
CREATE TRIGGER audit_logs_prevent_update
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

COMMIT;
