BEGIN;

CREATE TABLE IF NOT EXISTS tenant_communication_configs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel text NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  last_test_status text,
  last_tested_at timestamptz,
  last_test_error text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL,
  CONSTRAINT tenant_communication_configs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_communication_configs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tenant_communication_configs_channel_unique UNIQUE (tenant_id, channel),
  CONSTRAINT tenant_communication_configs_provider_check CHECK (
    (channel = 'email' AND provider = 'resend')
    OR (channel = 'sms' AND provider = 'twilio')
  ),
  CONSTRAINT tenant_communication_configs_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tenant_communication_configs_test_check CHECK (
    (last_test_status IS NULL AND last_tested_at IS NULL AND last_test_error IS NULL)
    OR (last_test_status = 'passed' AND last_tested_at IS NOT NULL AND last_test_error IS NULL)
    OR (last_test_status = 'failed' AND last_tested_at IS NOT NULL
      AND last_test_error IN (
        'provider_rejected', 'provider_timeout', 'secret_authentication_failed',
        'config_changed', 'delivery_expired', 'unexpected_provider_response'
      ))
  ),
  CONSTRAINT tenant_communication_configs_active_check CHECK (
    status = 'disabled' OR last_test_status = 'passed'
  ),
  CONSTRAINT tenant_communication_configs_version_check CHECK (version >= 0),
  CONSTRAINT tenant_communication_configs_timestamp_check CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION app.freeze_communication_config_identity()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.channel <> OLD.channel OR NEW.provider <> OLD.provider
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'communication configuration identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_communication_configs_freeze_identity
  ON tenant_communication_configs;
CREATE TRIGGER tenant_communication_configs_freeze_identity
BEFORE UPDATE ON tenant_communication_configs
FOR EACH ROW EXECUTE FUNCTION app.freeze_communication_config_identity();

DROP TRIGGER IF EXISTS tenant_communication_configs_set_updated_at
  ON tenant_communication_configs;
CREATE TRIGGER tenant_communication_configs_set_updated_at
BEFORE UPDATE ON tenant_communication_configs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_communication_configs_prevent_delete
  ON tenant_communication_configs;
CREATE TRIGGER tenant_communication_configs_prevent_delete
BEFORE DELETE ON tenant_communication_configs
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS tenant_communication_secrets (
  config_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  channel text NOT NULL,
  provider text NOT NULL,
  credentials_ciphertext text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT tenant_communication_secrets_config_fk
    FOREIGN KEY (tenant_id, config_id)
    REFERENCES tenant_communication_configs (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_communication_secrets_provider_check CHECK (
    (channel = 'email' AND provider = 'resend')
    OR (channel = 'sms' AND provider = 'twilio')
  ),
  CONSTRAINT tenant_communication_secrets_ciphertext_check CHECK (
    char_length(credentials_ciphertext) BETWEEN 40 AND 16384
  ),
  CONSTRAINT tenant_communication_secrets_key_version_check CHECK (
    key_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT tenant_communication_secrets_timestamp_check CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION app.enforce_communication_secret_binding()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenant_communication_configs AS config
    WHERE config.id = NEW.config_id AND config.tenant_id = NEW.tenant_id
      AND config.channel = NEW.channel AND config.provider = NEW.provider
  ) THEN
    RAISE EXCEPTION 'communication secret binding is invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.config_id <> OLD.config_id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.channel <> OLD.channel OR NEW.provider <> OLD.provider
    OR NEW.created_at <> OLD.created_at
  ) THEN
    RAISE EXCEPTION 'communication secret identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_communication_secrets_enforce_binding
  ON tenant_communication_secrets;
CREATE TRIGGER tenant_communication_secrets_enforce_binding
BEFORE INSERT OR UPDATE ON tenant_communication_secrets
FOR EACH ROW EXECUTE FUNCTION app.enforce_communication_secret_binding();

DROP TRIGGER IF EXISTS tenant_communication_secrets_set_updated_at
  ON tenant_communication_secrets;
CREATE TRIGGER tenant_communication_secrets_set_updated_at
BEFORE UPDATE ON tenant_communication_secrets
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_communication_secrets_prevent_delete
  ON tenant_communication_secrets;
CREATE TRIGGER tenant_communication_secrets_prevent_delete
BEFORE DELETE ON tenant_communication_secrets
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS customer_otp_delivery_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  challenge_id uuid,
  config_id uuid NOT NULL,
  config_version integer NOT NULL,
  job_type text NOT NULL DEFAULT 'otp',
  channel text NOT NULL,
  purpose text NOT NULL,
  payload_ciphertext text,
  key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_otp_delivery_jobs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_otp_delivery_jobs_challenge_fk FOREIGN KEY (challenge_id)
    REFERENCES customer_otp_challenges (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_otp_delivery_jobs_config_fk FOREIGN KEY (tenant_id, config_id)
    REFERENCES tenant_communication_configs (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_otp_delivery_jobs_challenge_unique UNIQUE (challenge_id),
  CONSTRAINT customer_otp_delivery_jobs_job_type_check CHECK (job_type IN ('otp', 'config_test')),
  CONSTRAINT customer_otp_delivery_jobs_challenge_check CHECK (
    (job_type = 'otp' AND challenge_id IS NOT NULL AND purpose IN (
      'verify_email', 'verify_phone', 'login', 'password_reset'
    ))
    OR (job_type = 'config_test' AND challenge_id IS NULL AND purpose = 'config_test')
  ),
  CONSTRAINT customer_otp_delivery_jobs_channel_check CHECK (channel IN ('email', 'sms')),
  CONSTRAINT customer_otp_delivery_jobs_config_version_check CHECK (config_version >= 0),
  CONSTRAINT customer_otp_delivery_jobs_payload_check CHECK (
    (status IN ('pending', 'processing', 'retry')
      AND char_length(payload_ciphertext) BETWEEN 40 AND 8192)
    OR (status IN ('sent', 'dead_letter', 'expired') AND payload_ciphertext IS NULL)
  ),
  CONSTRAINT customer_otp_delivery_jobs_key_version_check CHECK (
    key_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT customer_otp_delivery_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'sent', 'dead_letter', 'expired')
  ),
  CONSTRAINT customer_otp_delivery_jobs_attempt_check CHECK (
    attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 10
  ),
  CONSTRAINT customer_otp_delivery_jobs_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT customer_otp_delivery_jobs_lock_check CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT customer_otp_delivery_jobs_sent_check CHECK (
    (status = 'sent' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL
      AND char_length(provider_message_id) BETWEEN 1 AND 500
      AND provider_message_id ~ '^[-A-Za-z0-9._:@/+=]+$' AND last_error IS NULL)
    OR (status <> 'sent' AND sent_at IS NULL AND provider_message_id IS NULL)
  ),
  CONSTRAINT customer_otp_delivery_jobs_error_check CHECK (
    (status IN ('retry', 'dead_letter', 'expired') AND last_error IN (
      'provider_rejected', 'provider_timeout', 'secret_authentication_failed',
      'config_changed', 'delivery_expired', 'unexpected_provider_response'
    )) OR (status NOT IN ('retry', 'dead_letter', 'expired') AND last_error IS NULL)
  ),
  CONSTRAINT customer_otp_delivery_jobs_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS customer_otp_delivery_jobs_available_idx
  ON customer_otp_delivery_jobs (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');

CREATE OR REPLACE FUNCTION app.enforce_otp_delivery_job_binding()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenant_communication_configs AS config
    WHERE config.id = NEW.config_id AND config.tenant_id = NEW.tenant_id
      AND config.channel = NEW.channel
  ) THEN
    RAISE EXCEPTION 'OTP delivery configuration binding is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.job_type = 'otp' AND NOT EXISTS (
    SELECT 1 FROM customer_otp_challenges AS challenge
    WHERE challenge.id = NEW.challenge_id AND challenge.tenant_id = NEW.tenant_id
      AND (CASE WHEN challenge.channel = 'phone' THEN 'sms' ELSE challenge.channel END) = NEW.channel
      AND challenge.purpose = NEW.purpose AND challenge.expires_at = NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'OTP delivery challenge binding is invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.challenge_id IS DISTINCT FROM OLD.challenge_id OR NEW.config_id <> OLD.config_id
    OR NEW.config_version <> OLD.config_version OR NEW.job_type <> OLD.job_type
    OR NEW.channel <> OLD.channel OR NEW.purpose <> OLD.purpose
    OR NEW.key_version <> OLD.key_version
    OR NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at
  ) THEN
    RAISE EXCEPTION 'OTP delivery identity and encrypted payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('sent', 'dead_letter', 'expired') THEN
    RAISE EXCEPTION 'terminal OTP delivery is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payload_ciphertext IS NULL AND NEW.payload_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'cleared OTP delivery payload cannot be restored' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.payload_ciphertext IS NOT NULL
    AND NEW.payload_ciphertext IS DISTINCT FROM OLD.payload_ciphertext
    AND NEW.payload_ciphertext IS NOT NULL
  THEN
    RAISE EXCEPTION 'encrypted OTP delivery payload is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND NOT (
    (OLD.status IN ('pending', 'retry') AND NEW.status IN ('processing', 'expired'))
    OR (OLD.status = 'processing' AND NEW.status IN ('sent', 'retry', 'dead_letter', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid OTP delivery status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_otp_delivery_jobs_enforce_binding
  ON customer_otp_delivery_jobs;
CREATE TRIGGER customer_otp_delivery_jobs_enforce_binding
BEFORE INSERT OR UPDATE ON customer_otp_delivery_jobs
FOR EACH ROW EXECUTE FUNCTION app.enforce_otp_delivery_job_binding();

DROP TRIGGER IF EXISTS customer_otp_delivery_jobs_set_updated_at
  ON customer_otp_delivery_jobs;
CREATE TRIGGER customer_otp_delivery_jobs_set_updated_at
BEFORE UPDATE ON customer_otp_delivery_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS customer_otp_delivery_jobs_prevent_delete
  ON customer_otp_delivery_jobs;
CREATE TRIGGER customer_otp_delivery_jobs_prevent_delete
BEFORE DELETE ON customer_otp_delivery_jobs
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

ALTER TABLE tenant_communication_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_communication_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_communication_configs_tenant_select ON tenant_communication_configs;
CREATE POLICY tenant_communication_configs_tenant_select ON tenant_communication_configs
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_communication_configs_platform_access ON tenant_communication_configs;
CREATE POLICY tenant_communication_configs_platform_access ON tenant_communication_configs
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_communication_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_communication_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_communication_secrets_platform_access ON tenant_communication_secrets;
CREATE POLICY tenant_communication_secrets_platform_access ON tenant_communication_secrets
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_otp_delivery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_otp_delivery_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_otp_delivery_jobs_tenant_select ON customer_otp_delivery_jobs;
CREATE POLICY customer_otp_delivery_jobs_tenant_select ON customer_otp_delivery_jobs
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_otp_delivery_jobs_tenant_insert ON customer_otp_delivery_jobs;
CREATE POLICY customer_otp_delivery_jobs_tenant_insert ON customer_otp_delivery_jobs
  FOR INSERT WITH CHECK (
    tenant_id = app.current_tenant_id() AND job_type = 'otp'
  );
DROP POLICY IF EXISTS customer_otp_delivery_jobs_platform_access ON customer_otp_delivery_jobs;
CREATE POLICY customer_otp_delivery_jobs_platform_access ON customer_otp_delivery_jobs
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.freeze_communication_config_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_communication_secret_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_otp_delivery_job_binding() FROM PUBLIC;

COMMIT;
