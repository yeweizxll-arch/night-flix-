BEGIN;

CREATE TABLE IF NOT EXISTS customer_notification_preferences (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  preferred_locale text NOT NULL DEFAULT 'en-US',
  marketing_in_app_enabled boolean NOT NULL DEFAULT true,
  marketing_push_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_notification_preferences_pk PRIMARY KEY (tenant_id, account_id),
  CONSTRAINT customer_notification_preferences_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_notification_preferences_locale_check CHECK (
    preferred_locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT customer_notification_preferences_version_check CHECK (version >= 0),
  CONSTRAINT customer_notification_preferences_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS customer_notification_preferences_set_updated_at
  ON customer_notification_preferences;
CREATE TRIGGER customer_notification_preferences_set_updated_at
BEFORE UPDATE ON customer_notification_preferences
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_push_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  device_id uuid NOT NULL,
  platform text NOT NULL,
  token_ciphertext text NOT NULL,
  token_digest text NOT NULL,
  token_sha256 text NOT NULL,
  key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_push_tokens_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_push_tokens_device_fk FOREIGN KEY (tenant_id, account_id, device_id)
    REFERENCES customer_devices (tenant_id, account_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_push_tokens_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_push_tokens_platform_check CHECK (platform IN ('android', 'ios')),
  CONSTRAINT customer_push_tokens_ciphertext_check CHECK (
    char_length(token_ciphertext) BETWEEN 40 AND 8192
  ),
  CONSTRAINT customer_push_tokens_digest_check CHECK (
    token_digest ~ '^hmac-sha256\.[1-9][0-9]{0,9}\.[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT customer_push_tokens_sha256_check CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_push_tokens_key_version_check CHECK (key_version BETWEEN 1 AND 2147483647),
  CONSTRAINT customer_push_tokens_status_check CHECK (status IN ('active', 'revoked')),
  CONSTRAINT customer_push_tokens_revocation_check CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
    OR (
      status = 'revoked' AND revoked_at IS NOT NULL
      AND revoke_reason IS NOT NULL
      AND char_length(btrim(revoke_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT customer_push_tokens_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_push_tokens_digest_unique_idx
  ON customer_push_tokens (tenant_id, token_digest) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS customer_push_tokens_sha256_unique_idx
  ON customer_push_tokens (tenant_id, token_sha256) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS customer_push_tokens_active_device_unique_idx
  ON customer_push_tokens (tenant_id, account_id, device_id, platform)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS customer_push_tokens_account_active_idx
  ON customer_push_tokens (tenant_id, account_id, created_at DESC, id)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION app.enforce_customer_push_token_device()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  active_count integer;
BEGIN
  IF NEW.status = 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM customer_devices AS device
      WHERE device.tenant_id = NEW.tenant_id
        AND device.account_id = NEW.account_id
        AND device.id = NEW.device_id
        AND device.status = 'active'
        AND device.platform = NEW.platform
    ) THEN
      RAISE EXCEPTION 'push token must belong to an active matching customer device'
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::integer INTO active_count
    FROM customer_push_tokens AS token
    WHERE token.tenant_id = NEW.tenant_id
      AND token.account_id = NEW.account_id
      AND token.status = 'active'
      AND token.id <> NEW.id;
    IF active_count >= 3 THEN
      RAISE EXCEPTION 'customer may have at most three active push devices'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_push_tokens_enforce_device ON customer_push_tokens;
CREATE TRIGGER customer_push_tokens_enforce_device
BEFORE INSERT OR UPDATE OF tenant_id, account_id, device_id, platform, status
ON customer_push_tokens
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_push_token_device();

CREATE OR REPLACE FUNCTION app.freeze_customer_push_token_secret()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.device_id <> OLD.device_id
    OR NEW.platform <> OLD.platform
    OR NEW.token_ciphertext <> OLD.token_ciphertext
    OR NEW.token_digest <> OLD.token_digest
    OR NEW.token_sha256 <> OLD.token_sha256
    OR NEW.key_version <> OLD.key_version
  THEN
    RAISE EXCEPTION 'push token identity and encrypted secret are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_push_tokens_freeze_secret ON customer_push_tokens;
CREATE TRIGGER customer_push_tokens_freeze_secret
BEFORE UPDATE ON customer_push_tokens
FOR EACH ROW EXECUTE FUNCTION app.freeze_customer_push_token_secret();

DROP TRIGGER IF EXISTS customer_push_tokens_set_updated_at ON customer_push_tokens;
CREATE TRIGGER customer_push_tokens_set_updated_at
BEFORE UPDATE ON customer_push_tokens
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS customer_push_tokens_prevent_delete ON customer_push_tokens;
CREATE TRIGGER customer_push_tokens_prevent_delete
BEFORE DELETE ON customer_push_tokens
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.revoke_push_tokens_with_device()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'revoked' THEN
    UPDATE customer_push_tokens
    SET status = 'revoked', revoked_at = statement_timestamp(),
      revoke_reason = 'customer device revoked'
    WHERE tenant_id = NEW.tenant_id
      AND account_id = NEW.account_id
      AND device_id = NEW.id
      AND status = 'active';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_devices_revoke_push_tokens ON customer_devices;
CREATE TRIGGER customer_devices_revoke_push_tokens
AFTER UPDATE OF status ON customer_devices
FOR EACH ROW EXECUTE FUNCTION app.revoke_push_tokens_with_device();

CREATE TABLE IF NOT EXISTS notification_provider_configs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  credentials_ciphertext text NOT NULL,
  key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'disabled',
  last_test_status text,
  last_tested_at timestamptz,
  last_test_error text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT notification_provider_configs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_provider_configs_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT notification_provider_configs_provider_unique UNIQUE (tenant_id, provider),
  CONSTRAINT notification_provider_configs_provider_check CHECK (provider IN ('apns', 'fcm')),
  CONSTRAINT notification_provider_configs_ciphertext_check CHECK (
    char_length(credentials_ciphertext) BETWEEN 40 AND 16384
  ),
  CONSTRAINT notification_provider_configs_key_version_check CHECK (
    key_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT notification_provider_configs_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT notification_provider_configs_active_test_check CHECK (
    status = 'disabled' OR last_test_status = 'passed'
  ),
  CONSTRAINT notification_provider_configs_test_check CHECK (
    (
      last_test_status IS NULL AND last_tested_at IS NULL AND last_test_error IS NULL
    )
    OR (
      last_test_status = 'passed' AND last_tested_at IS NOT NULL AND last_test_error IS NULL
    )
    OR (
      last_test_status = 'failed' AND last_tested_at IS NOT NULL
      AND last_test_error IS NOT NULL
      AND last_test_error IN (
        'provider_adapter_unavailable',
        'secret_authentication_failed',
        'external_provider_failure'
      )
    )
  ),
  CONSTRAINT notification_provider_configs_version_check CHECK (version >= 0),
  CONSTRAINT notification_provider_configs_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS notification_provider_configs_set_updated_at
  ON notification_provider_configs;
CREATE TRIGGER notification_provider_configs_set_updated_at
BEFORE UPDATE ON notification_provider_configs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.freeze_notification_provider_config_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'notification provider configuration identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notification_provider_configs_freeze_identity
  ON notification_provider_configs;
CREATE TRIGGER notification_provider_configs_freeze_identity
BEFORE UPDATE ON notification_provider_configs
FOR EACH ROW EXECUTE FUNCTION app.freeze_notification_provider_config_identity();

CREATE TABLE IF NOT EXISTS notification_campaigns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  channels text[] NOT NULL,
  target_type text NOT NULL,
  target_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  deep_link text,
  scheduled_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  expansion_completed_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT notification_campaigns_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_campaigns_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT notification_campaigns_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT notification_campaigns_status_check CHECK (
    status IN ('draft', 'scheduled', 'dispatching', 'completed', 'cancelled')
  ),
  CONSTRAINT notification_campaigns_channels_check CHECK (
    cardinality(channels) BETWEEN 1 AND 2
    AND channels <@ ARRAY['in_app', 'push']::text[]
    AND (cardinality(channels) = 1 OR channels[1] <> channels[2])
  ),
  CONSTRAINT notification_campaigns_target_check CHECK (
    target_type IN ('all', 'conditions') AND jsonb_typeof(target_json) = 'object'
  ),
  CONSTRAINT notification_campaigns_deep_link_check CHECK (
    deep_link IS NULL OR char_length(deep_link) BETWEEN 1 AND 1000
  ),
  CONSTRAINT notification_campaigns_schedule_check CHECK (
    (status = 'draft' AND scheduled_at IS NULL AND cancelled_at IS NULL)
    OR (status IN ('scheduled', 'dispatching', 'completed') AND scheduled_at IS NOT NULL AND cancelled_at IS NULL)
    OR (
      status = 'cancelled' AND cancelled_at IS NOT NULL
      AND cancel_reason IS NOT NULL
      AND char_length(btrim(cancel_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT notification_campaigns_completion_check CHECK (
    (status = 'completed' AND expansion_completed_at IS NOT NULL)
    OR (status <> 'completed' AND expansion_completed_at IS NULL)
  ),
  CONSTRAINT notification_campaigns_version_check CHECK (version >= 0),
  CONSTRAINT notification_campaigns_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS notification_campaigns_due_idx
  ON notification_campaigns (scheduled_at, id)
  WHERE status = 'scheduled';

CREATE OR REPLACE FUNCTION app.enforce_notification_campaign_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'campaign tenant and creator are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('scheduled', 'cancelled'))
    OR (OLD.status = 'scheduled' AND NEW.status IN ('dispatching', 'cancelled'))
    OR (OLD.status = 'dispatching' AND NEW.status IN ('completed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid notification campaign transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.name <> OLD.name OR NEW.channels <> OLD.channels
    OR NEW.target_type <> OLD.target_type OR NEW.target_json <> OLD.target_json
    OR NEW.deep_link IS DISTINCT FROM OLD.deep_link
    OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
  ) THEN
    RAISE EXCEPTION 'scheduled campaign content and targeting are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notification_campaigns_enforce_transition ON notification_campaigns;
CREATE TRIGGER notification_campaigns_enforce_transition
BEFORE UPDATE ON notification_campaigns
FOR EACH ROW EXECUTE FUNCTION app.enforce_notification_campaign_transition();

DROP TRIGGER IF EXISTS notification_campaigns_set_updated_at ON notification_campaigns;
CREATE TRIGGER notification_campaigns_set_updated_at
BEFORE UPDATE ON notification_campaigns
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS notification_campaign_translations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notification_campaign_translations_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES notification_campaigns (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT notification_campaign_translations_unique UNIQUE (tenant_id, campaign_id, locale),
  CONSTRAINT notification_campaign_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT notification_campaign_translations_title_check CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 200
  ),
  CONSTRAINT notification_campaign_translations_body_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 2000
  )
);

CREATE OR REPLACE FUNCTION app.enforce_notification_translation_draft()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  effective_tenant_id uuid;
  effective_campaign_id uuid;
BEGIN
  effective_tenant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  effective_campaign_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.campaign_id ELSE NEW.campaign_id END;
  IF NOT EXISTS (
    SELECT 1 FROM notification_campaigns
    WHERE tenant_id = effective_tenant_id
      AND id = effective_campaign_id
      AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'campaign translations are immutable after scheduling'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

DROP TRIGGER IF EXISTS notification_campaign_translations_enforce_draft
  ON notification_campaign_translations;
CREATE TRIGGER notification_campaign_translations_enforce_draft
BEFORE INSERT OR UPDATE OR DELETE ON notification_campaign_translations
FOR EACH ROW EXECUTE FUNCTION app.enforce_notification_translation_draft();

CREATE TABLE IF NOT EXISTS notification_dispatch_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  job_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer,
  status text NOT NULL DEFAULT 'pending',
  retry_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notification_dispatch_jobs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_dispatch_jobs_event_unique UNIQUE (event_id),
  CONSTRAINT notification_dispatch_jobs_type_check CHECK (
    job_type IN ('campaign_expand', 'provider_test')
  ),
  CONSTRAINT notification_dispatch_jobs_aggregate_version_check CHECK (
    (job_type = 'campaign_expand' AND aggregate_version IS NULL)
    OR (job_type = 'provider_test' AND aggregate_version >= 0)
  ),
  CONSTRAINT notification_dispatch_jobs_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'completed', 'dead_letter')
  ),
  CONSTRAINT notification_dispatch_jobs_retry_check CHECK (
    retry_count >= 0 AND max_attempts BETWEEN 1 AND 100 AND retry_count <= max_attempts
  ),
  CONSTRAINT notification_dispatch_jobs_lock_check CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT notification_dispatch_jobs_error_check CHECK (
    (status IN ('retry', 'dead_letter') AND last_error IS NOT NULL)
    OR (status NOT IN ('retry', 'dead_letter') AND last_error IS NULL)
  ),
  CONSTRAINT notification_dispatch_jobs_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS notification_dispatch_jobs_available_idx
  ON notification_dispatch_jobs (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');

DROP TRIGGER IF EXISTS notification_dispatch_jobs_set_updated_at
  ON notification_dispatch_jobs;
CREATE TRIGGER notification_dispatch_jobs_set_updated_at
BEFORE UPDATE ON notification_dispatch_jobs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS notification_event_consumptions (
  event_id uuid NOT NULL,
  consumer text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notification_event_consumptions_pk PRIMARY KEY (event_id, consumer),
  CONSTRAINT notification_event_consumptions_consumer_check CHECK (
    consumer ~ '^[a-z][a-z0-9_.-]{2,99}$'
  )
);

DROP TRIGGER IF EXISTS notification_event_consumptions_prevent_mutation
  ON notification_event_consumptions;
CREATE TRIGGER notification_event_consumptions_prevent_mutation
BEFORE UPDATE OR DELETE ON notification_event_consumptions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS notification_campaign_recipients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  account_id uuid NOT NULL,
  locale text NOT NULL,
  expansion_event_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notification_campaign_recipients_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES notification_campaigns (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_campaign_recipients_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_campaign_recipients_unique UNIQUE (tenant_id, campaign_id, account_id),
  CONSTRAINT notification_campaign_recipients_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT notification_campaign_recipients_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  )
);

CREATE TABLE IF NOT EXISTS customer_inbox_messages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  campaign_id uuid,
  category text NOT NULL,
  source_type text NOT NULL,
  locale text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deep_link text,
  status text NOT NULL DEFAULT 'unread',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT customer_inbox_messages_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT customer_inbox_messages_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES notification_campaigns (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_inbox_messages_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_inbox_messages_category_check CHECK (
    category IN ('marketing', 'transactional')
  ),
  CONSTRAINT customer_inbox_messages_source_check CHECK (
    (source_type = 'campaign' AND category = 'marketing' AND campaign_id IS NOT NULL)
    OR (source_type = 'system' AND category = 'transactional' AND campaign_id IS NULL)
  ),
  CONSTRAINT customer_inbox_messages_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT customer_inbox_messages_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT customer_inbox_messages_body_check CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  CONSTRAINT customer_inbox_messages_deep_link_check CHECK (
    deep_link IS NULL OR char_length(deep_link) BETWEEN 1 AND 1000
  ),
  CONSTRAINT customer_inbox_messages_status_check CHECK (status IN ('unread', 'read')),
  CONSTRAINT customer_inbox_messages_read_check CHECK (
    (status = 'unread' AND read_at IS NULL)
    OR (status = 'read' AND read_at IS NOT NULL)
  ),
  CONSTRAINT customer_inbox_messages_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS customer_inbox_messages_account_idx
  ON customer_inbox_messages (tenant_id, account_id, created_at DESC, id);

DROP TRIGGER IF EXISTS customer_inbox_messages_set_updated_at ON customer_inbox_messages;
CREATE TRIGGER customer_inbox_messages_set_updated_at
BEFORE UPDATE ON customer_inbox_messages
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_customer_inbox_message_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
    OR NEW.category <> OLD.category OR NEW.source_type <> OLD.source_type
    OR NEW.locale <> OLD.locale OR NEW.title <> OLD.title OR NEW.body <> OLD.body
    OR NEW.deep_link IS DISTINCT FROM OLD.deep_link OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'inbox message identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'read' AND NEW.status <> 'read' THEN
    RAISE EXCEPTION 'read inbox messages cannot become unread'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_inbox_messages_enforce_update ON customer_inbox_messages;
CREATE TRIGGER customer_inbox_messages_enforce_update
BEFORE UPDATE ON customer_inbox_messages
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_inbox_message_update();

DROP TRIGGER IF EXISTS customer_inbox_messages_prevent_delete ON customer_inbox_messages;
CREATE TRIGGER customer_inbox_messages_prevent_delete
BEFORE DELETE ON customer_inbox_messages
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  campaign_id uuid,
  recipient_id uuid,
  inbox_message_id uuid,
  push_token_id uuid,
  provider_config_id uuid,
  source_type text NOT NULL,
  category text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deep_link text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT notification_deliveries_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_campaign_fk FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES notification_campaigns (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_recipient_fk FOREIGN KEY (tenant_id, recipient_id)
    REFERENCES notification_campaign_recipients (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_inbox_fk FOREIGN KEY (tenant_id, inbox_message_id)
    REFERENCES customer_inbox_messages (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_push_token_fk FOREIGN KEY (tenant_id, push_token_id)
    REFERENCES customer_push_tokens (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_provider_config_fk FOREIGN KEY (tenant_id, provider_config_id)
    REFERENCES notification_provider_configs (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT notification_deliveries_dedupe_unique UNIQUE (tenant_id, dedupe_key),
  CONSTRAINT notification_deliveries_category_check CHECK (category IN ('marketing', 'transactional')),
  CONSTRAINT notification_deliveries_source_check CHECK (
    (source_type = 'campaign' AND category = 'marketing'
      AND campaign_id IS NOT NULL AND recipient_id IS NOT NULL)
    OR (source_type = 'system' AND category = 'transactional'
      AND campaign_id IS NULL AND recipient_id IS NULL)
  ),
  CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('in_app', 'push')),
  CONSTRAINT notification_deliveries_channel_binding_check CHECK (
    (channel = 'in_app' AND inbox_message_id IS NOT NULL
      AND push_token_id IS NULL AND provider_config_id IS NULL)
    OR (channel = 'push' AND inbox_message_id IS NULL
      AND push_token_id IS NOT NULL AND provider_config_id IS NOT NULL)
  ),
  CONSTRAINT notification_deliveries_status_check CHECK (
    status IN ('pending', 'processing', 'sent', 'retry', 'dead_letter', 'skipped')
  ),
  CONSTRAINT notification_deliveries_retry_check CHECK (
    attempt_count >= 0 AND max_attempts BETWEEN 1 AND 20 AND attempt_count <= max_attempts
  ),
  CONSTRAINT notification_deliveries_lock_check CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT notification_deliveries_sent_check CHECK (
    (status = 'sent' AND sent_at IS NOT NULL AND last_error IS NULL
      AND (
        (channel = 'in_app' AND provider_message_id IS NULL)
        OR (
          channel = 'push' AND provider_message_id IS NOT NULL
          AND char_length(provider_message_id) BETWEEN 1 AND 500
          AND provider_message_id ~ '^[-A-Za-z0-9._:@/+=]+$'
        )
      )
    )
    OR (status <> 'sent' AND sent_at IS NULL AND provider_message_id IS NULL)
  ),
  CONSTRAINT notification_deliveries_error_check CHECK (
    (status IN ('retry', 'dead_letter', 'skipped') AND last_error IS NOT NULL)
    OR (status NOT IN ('retry', 'dead_letter', 'skipped') AND last_error IS NULL)
  ),
  CONSTRAINT notification_deliveries_payload_check CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 200
    AND char_length(btrim(body)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT notification_deliveries_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS notification_deliveries_available_idx
  ON notification_deliveries (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS notification_deliveries_account_idx
  ON notification_deliveries (tenant_id, account_id, created_at DESC, id);

DROP TRIGGER IF EXISTS notification_deliveries_set_updated_at ON notification_deliveries;
CREATE TRIGGER notification_deliveries_set_updated_at
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_notification_delivery_bindings()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.recipient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM notification_campaign_recipients AS recipient
    WHERE recipient.id = NEW.recipient_id
      AND recipient.tenant_id = NEW.tenant_id
      AND recipient.account_id = NEW.account_id
      AND recipient.campaign_id = NEW.campaign_id
  ) THEN
    RAISE EXCEPTION 'delivery recipient account or campaign binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.inbox_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customer_inbox_messages AS message
    WHERE message.id = NEW.inbox_message_id
      AND message.tenant_id = NEW.tenant_id
      AND message.account_id = NEW.account_id
      AND message.campaign_id IS NOT DISTINCT FROM NEW.campaign_id
      AND message.category = NEW.category
  ) THEN
    RAISE EXCEPTION 'delivery inbox account, campaign, or category binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.push_token_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM customer_push_tokens AS token
    INNER JOIN notification_provider_configs AS config
      ON config.tenant_id = token.tenant_id
      AND config.id = NEW.provider_config_id
      AND config.status = 'active'
      AND (
        (token.platform = 'ios' AND config.provider = 'apns')
        OR (token.platform = 'android' AND config.provider = 'fcm')
      )
    WHERE token.id = NEW.push_token_id
      AND token.tenant_id = NEW.tenant_id
      AND token.account_id = NEW.account_id
      AND token.status = 'active'
  ) THEN
    RAISE EXCEPTION 'delivery push token or active matching provider binding is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notification_deliveries_enforce_bindings
  ON notification_deliveries;
CREATE TRIGGER notification_deliveries_enforce_bindings
BEFORE INSERT OR UPDATE OF tenant_id, account_id, campaign_id, recipient_id,
  inbox_message_id, push_token_id, provider_config_id, category, source_type
ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION app.enforce_notification_delivery_bindings();

CREATE OR REPLACE FUNCTION app.enforce_tenant_notification_delivery_skip()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF app.has_platform_access(current_user)
    OR current_setting('app.access_scope', true) IS DISTINCT FROM 'tenant'
  THEN
    RETURN NEW;
  END IF;
  IF OLD.source_type <> 'campaign' OR OLD.campaign_id IS NULL
    OR OLD.status NOT IN ('pending', 'retry') OR NEW.status <> 'skipped'
    OR NEW.last_error <> 'campaign_cancelled'
    OR ROW(
      NEW.id, NEW.tenant_id, NEW.account_id, NEW.campaign_id, NEW.recipient_id,
      NEW.inbox_message_id, NEW.push_token_id, NEW.provider_config_id,
      NEW.source_type, NEW.category, NEW.channel, NEW.dedupe_key,
      NEW.title, NEW.body, NEW.deep_link, NEW.attempt_count, NEW.max_attempts,
      NEW.available_at, NEW.locked_at, NEW.locked_by, NEW.sent_at,
      NEW.provider_message_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.account_id, OLD.campaign_id, OLD.recipient_id,
      OLD.inbox_message_id, OLD.push_token_id, OLD.provider_config_id,
      OLD.source_type, OLD.category, OLD.channel, OLD.dedupe_key,
      OLD.title, OLD.body, OLD.deep_link, OLD.attempt_count, OLD.max_attempts,
      OLD.available_at, OLD.locked_at, OLD.locked_by, OLD.sent_at,
      OLD.provider_message_id, OLD.created_at
    )
  THEN
    RAISE EXCEPTION 'tenant may only cancel an unclaimed campaign delivery'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS notification_deliveries_enforce_tenant_skip
  ON notification_deliveries;
CREATE TRIGGER notification_deliveries_enforce_tenant_skip
BEFORE UPDATE ON notification_deliveries
FOR EACH ROW EXECUTE FUNCTION app.enforce_tenant_notification_delivery_skip();

-- Tenant context may read/write customer-owned preference/token/inbox rows only
-- through application predicates; RLS provides the non-bypassable tenant boundary.
DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'customer_notification_preferences',
    'customer_push_tokens',
    'notification_provider_configs',
    'notification_campaigns',
    'notification_campaign_translations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id())',
      table_name || '_tenant_isolation', table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_platform_access', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user))',
      table_name || '_platform_access', table_name
    );
  END LOOP;
END
$policies$;

ALTER TABLE customer_inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_inbox_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_inbox_messages_tenant_isolation ON customer_inbox_messages;
DROP POLICY IF EXISTS customer_inbox_messages_tenant_select ON customer_inbox_messages;
CREATE POLICY customer_inbox_messages_tenant_select ON customer_inbox_messages
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_inbox_messages_tenant_update ON customer_inbox_messages;
CREATE POLICY customer_inbox_messages_tenant_update ON customer_inbox_messages
  FOR UPDATE USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_inbox_messages_platform_access ON customer_inbox_messages;
CREATE POLICY customer_inbox_messages_platform_access ON customer_inbox_messages
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE notification_dispatch_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_dispatch_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_dispatch_jobs_tenant_select ON notification_dispatch_jobs;
CREATE POLICY notification_dispatch_jobs_tenant_select ON notification_dispatch_jobs
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS notification_dispatch_jobs_tenant_insert ON notification_dispatch_jobs;
CREATE POLICY notification_dispatch_jobs_tenant_insert ON notification_dispatch_jobs
  FOR INSERT WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS notification_dispatch_jobs_platform_access ON notification_dispatch_jobs;
CREATE POLICY notification_dispatch_jobs_platform_access ON notification_dispatch_jobs
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE notification_event_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_event_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_event_consumptions_platform_access
  ON notification_event_consumptions;
CREATE POLICY notification_event_consumptions_platform_access
  ON notification_event_consumptions FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE notification_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_campaign_recipients FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_campaign_recipients_tenant_select
  ON notification_campaign_recipients;
CREATE POLICY notification_campaign_recipients_tenant_select
  ON notification_campaign_recipients FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS notification_campaign_recipients_platform_access
  ON notification_campaign_recipients;
CREATE POLICY notification_campaign_recipients_platform_access
  ON notification_campaign_recipients FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_deliveries_tenant_select ON notification_deliveries;
CREATE POLICY notification_deliveries_tenant_select ON notification_deliveries
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS notification_deliveries_tenant_update ON notification_deliveries;
CREATE POLICY notification_deliveries_tenant_update ON notification_deliveries
  FOR UPDATE USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS notification_deliveries_platform_access ON notification_deliveries;
CREATE POLICY notification_deliveries_platform_access ON notification_deliveries
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMIT;
