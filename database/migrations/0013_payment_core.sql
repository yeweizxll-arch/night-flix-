BEGIN;

CREATE TABLE IF NOT EXISTS payment_providers (
  id uuid PRIMARY KEY,
  code citext NOT NULL UNIQUE,
  adapter_code text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT payment_providers_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT payment_providers_adapter_check CHECK (
    adapter_code ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT payment_providers_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT payment_providers_capabilities_check CHECK (
    jsonb_typeof(capabilities_json) = 'object'
  ),
  CONSTRAINT payment_providers_version_check CHECK (version >= 0),
  CONSTRAINT payment_providers_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS payment_providers_set_updated_at ON payment_providers;
CREATE TRIGGER payment_providers_set_updated_at
BEFORE UPDATE ON payment_providers
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_payment_provider_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code
    OR NEW.adapter_code IS DISTINCT FROM OLD.adapter_code
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Payment provider identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_providers_enforce_identity ON payment_providers;
CREATE TRIGGER payment_providers_enforce_identity
BEFORE UPDATE ON payment_providers
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_provider_identity();

CREATE TABLE IF NOT EXISTS payment_configs (
  id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  provider_id uuid NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  public_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT payment_configs_tenant_fk FOREIGN KEY (owner_tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_configs_provider_fk FOREIGN KEY (provider_id)
    REFERENCES payment_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_configs_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT payment_configs_label_check CHECK (
    char_length(btrim(label)) BETWEEN 1 AND 100
  ),
  CONSTRAINT payment_configs_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT payment_configs_metadata_check CHECK (
    jsonb_typeof(public_metadata_json) = 'object'
  ),
  CONSTRAINT payment_configs_version_check CHECK (version >= 0),
  CONSTRAINT payment_configs_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT payment_configs_owner_id_unique UNIQUE (owner_type, owner_tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_configs_platform_label_unique_idx
  ON payment_configs (label) WHERE owner_type = 'platform';
CREATE UNIQUE INDEX IF NOT EXISTS payment_configs_tenant_label_unique_idx
  ON payment_configs (owner_tenant_id, label) WHERE owner_type = 'tenant';
CREATE INDEX IF NOT EXISTS payment_configs_provider_status_idx
  ON payment_configs (provider_id, status, owner_type, owner_tenant_id);

DROP TRIGGER IF EXISTS payment_configs_set_updated_at ON payment_configs;
CREATE TRIGGER payment_configs_set_updated_at
BEFORE UPDATE ON payment_configs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_payment_config_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.owner_type IS DISTINCT FROM OLD.owner_type
    OR NEW.owner_tenant_id IS DISTINCT FROM OLD.owner_tenant_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Payment config identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_configs_enforce_identity ON payment_configs;
CREATE TRIGGER payment_configs_enforce_identity
BEFORE UPDATE ON payment_configs
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_config_identity();

CREATE TABLE IF NOT EXISTS payment_config_secrets (
  payment_config_id uuid PRIMARY KEY,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  credential_ciphertext text NOT NULL,
  credential_key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_config_secrets_config_id_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT payment_config_secrets_config_fk FOREIGN KEY (
    owner_type, owner_tenant_id, payment_config_id
  ) REFERENCES payment_configs (owner_type, owner_tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT payment_config_secrets_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT payment_config_secrets_ciphertext_check CHECK (
    char_length(credential_ciphertext) BETWEEN 20 AND 16384
  ),
  CONSTRAINT payment_config_secrets_key_version_check CHECK (
    credential_key_version > 0
  ),
  CONSTRAINT payment_config_secrets_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS payment_config_secrets_set_updated_at ON payment_config_secrets;
CREATE TRIGGER payment_config_secrets_set_updated_at
BEFORE UPDATE ON payment_config_secrets
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_fake_payment_config_credentials()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  selected_adapter text;
  selected_owner text;
  selected_tenant uuid;
BEGIN
  SELECT provider.adapter_code, config.owner_type, config.owner_tenant_id
  INTO selected_adapter, selected_owner, selected_tenant
  FROM payment_configs AS config
  INNER JOIN payment_providers AS provider ON provider.id = config.provider_id
  WHERE config.id = NEW.payment_config_id;
  IF selected_adapter IS NULL
    OR selected_owner <> NEW.owner_type
    OR selected_tenant IS DISTINCT FROM NEW.owner_tenant_id
  THEN
    RAISE EXCEPTION 'Payment config secret scope does not match its config'
      USING ERRCODE = '23514';
  END IF;
  IF selected_adapter = 'fake'
  THEN
    RAISE EXCEPTION 'Fake payment configs do not accept stored credentials'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_config_secrets_enforce_fake
  ON payment_config_secrets;
CREATE TRIGGER payment_config_secrets_enforce_fake
BEFORE INSERT OR UPDATE OF payment_config_id, credential_ciphertext,
  credential_key_version
ON payment_config_secrets
FOR EACH ROW EXECUTE FUNCTION app.enforce_fake_payment_config_credentials();

CREATE TABLE IF NOT EXISTS tenant_payment_routing (
  tenant_id uuid PRIMARY KEY,
  collection_mode text NOT NULL,
  payment_config_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT tenant_payment_routing_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_payment_routing_config_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_payment_routing_mode_check CHECK (
    collection_mode IN ('platform_collect', 'tenant_direct')
  ),
  CONSTRAINT tenant_payment_routing_version_check CHECK (version >= 0),
  CONSTRAINT tenant_payment_routing_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS tenant_payment_routing_set_updated_at ON tenant_payment_routing;
CREATE TRIGGER tenant_payment_routing_set_updated_at
BEFORE UPDATE ON tenant_payment_routing
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_payment_routing_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  config_owner text;
  config_tenant uuid;
  config_status text;
BEGIN
  SELECT owner_type, owner_tenant_id, status
  INTO config_owner, config_tenant, config_status
  FROM payment_configs
  WHERE id = NEW.payment_config_id;

  IF config_status <> 'active'
    OR (NEW.collection_mode = 'platform_collect' AND config_owner <> 'platform')
    OR (
      NEW.collection_mode = 'tenant_direct'
      AND (config_owner <> 'tenant' OR config_tenant IS DISTINCT FROM NEW.tenant_id)
    )
  THEN
    RAISE EXCEPTION 'Payment route does not match the selected config scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_payment_routing_enforce_scope ON tenant_payment_routing;
CREATE TRIGGER tenant_payment_routing_enforce_scope
BEFORE INSERT OR UPDATE OF tenant_id, collection_mode, payment_config_id
ON tenant_payment_routing
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_routing_scope();

CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  payment_config_id uuid NOT NULL,
  adapter_code_snapshot text NOT NULL,
  collection_mode text NOT NULL,
  status text NOT NULL DEFAULT 'initialized',
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  external_payment_id text,
  checkout_reference text,
  idempotency_key text NOT NULL,
  failure_code text,
  failure_message text,
  succeeded_at timestamptz,
  failed_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_attempts_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_provider_fk FOREIGN KEY (provider_id)
    REFERENCES payment_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_config_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_attempts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT payment_attempts_idempotency_unique UNIQUE (
    tenant_id, account_id, order_id, idempotency_key
  ),
  CONSTRAINT payment_attempts_collection_mode_check CHECK (
    collection_mode IN ('platform_collect', 'tenant_direct')
  ),
  CONSTRAINT payment_attempts_adapter_snapshot_check CHECK (
    adapter_code_snapshot ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT payment_attempts_status_check CHECK (
    status IN ('initialized', 'pending', 'succeeded', 'failed', 'expired', 'cancelled')
  ),
  CONSTRAINT payment_attempts_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT payment_attempts_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT payment_attempts_external_id_check CHECK (
    external_payment_id IS NULL
    OR char_length(external_payment_id) BETWEEN 3 AND 300
  ),
  CONSTRAINT payment_attempts_checkout_check CHECK (
    checkout_reference IS NULL
    OR char_length(checkout_reference) BETWEEN 8 AND 1000
  ),
  CONSTRAINT payment_attempts_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT payment_attempts_failure_check CHECK (
    (status = 'failed' AND failure_code IS NOT NULL AND failure_message IS NOT NULL)
    OR (status <> 'failed' AND failure_code IS NULL AND failure_message IS NULL)
  ),
  CONSTRAINT payment_attempts_completion_check CHECK (
    (status = 'succeeded' AND succeeded_at IS NOT NULL AND failed_at IS NULL)
    OR (status = 'failed' AND succeeded_at IS NULL AND failed_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed') AND succeeded_at IS NULL AND failed_at IS NULL)
  ),
  CONSTRAINT payment_attempts_version_check CHECK (version >= 0),
  CONSTRAINT payment_attempts_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_external_unique_idx
  ON payment_attempts (provider_id, external_payment_id)
  WHERE external_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_attempts_order_idx
  ON payment_attempts (tenant_id, order_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_customer_idx
  ON payment_attempts (tenant_id, account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_attempts_pending_idx
  ON payment_attempts (created_at, id) WHERE status IN ('initialized', 'pending');

DROP TRIGGER IF EXISTS payment_attempts_set_updated_at ON payment_attempts;
CREATE TRIGGER payment_attempts_set_updated_at
BEFORE UPDATE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_payment_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.payment_config_id IS DISTINCT FROM OLD.payment_config_id
    OR NEW.adapter_code_snapshot IS DISTINCT FROM OLD.adapter_code_snapshot
    OR NEW.collection_mode IS DISTINCT FROM OLD.collection_mode
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Payment attempt snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.external_payment_id IS NOT NULL
    AND NEW.external_payment_id IS DISTINCT FROM OLD.external_payment_id
  THEN
    RAISE EXCEPTION 'External payment ID is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.checkout_reference IS NOT NULL
    AND NEW.checkout_reference IS DISTINCT FROM OLD.checkout_reference
  THEN
    RAISE EXCEPTION 'Checkout reference is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'initialized' AND NEW.status IN (
      'pending', 'succeeded', 'failed', 'expired', 'cancelled'
    ) THEN
      NULL;
    ELSIF OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Payment attempt status transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_attempts_enforce_transition ON payment_attempts;
CREATE TRIGGER payment_attempts_enforce_transition
BEFORE UPDATE ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_attempt_transition();

CREATE TABLE IF NOT EXISTS payment_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  order_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  transaction_type text NOT NULL,
  status text NOT NULL,
  external_transaction_id text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  payload_hash text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_transactions_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES payment_attempts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_provider_fk FOREIGN KEY (provider_id)
    REFERENCES payment_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_type_check CHECK (
    transaction_type IN ('charge', 'refund')
  ),
  CONSTRAINT payment_transactions_status_check CHECK (status IN ('succeeded', 'failed')),
  CONSTRAINT payment_transactions_external_unique UNIQUE (
    provider_id, external_transaction_id, transaction_type
  ),
  CONSTRAINT payment_transactions_external_check CHECK (
    char_length(external_transaction_id) BETWEEN 3 AND 300
  ),
  CONSTRAINT payment_transactions_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT payment_transactions_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT payment_transactions_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_transactions_occurred_check CHECK (occurred_at <= created_at + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS payment_transactions_attempt_idx
  ON payment_transactions (tenant_id, attempt_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_transactions_order_idx
  ON payment_transactions (tenant_id, order_id, occurred_at DESC, id DESC);

DROP TRIGGER IF EXISTS payment_transactions_prevent_mutation ON payment_transactions;
CREATE TRIGGER payment_transactions_prevent_mutation
BEFORE UPDATE OR DELETE ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_payment_transaction_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_attempts AS attempt
    WHERE attempt.id = NEW.attempt_id
      AND attempt.tenant_id = NEW.tenant_id
      AND attempt.order_id = NEW.order_id
      AND attempt.provider_id = NEW.provider_id
      AND attempt.currency = NEW.currency
      AND attempt.amount_minor = NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Payment transaction does not match its attempt snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_transactions_enforce_snapshot ON payment_transactions;
CREATE TRIGGER payment_transactions_enforce_snapshot
BEFORE INSERT ON payment_transactions
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_transaction_snapshot();

CREATE OR REPLACE FUNCTION app.enforce_payment_attempt_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.payment_config_id IS DISTINCT FROM OLD.payment_config_id
    OR NEW.adapter_code_snapshot IS DISTINCT FROM OLD.adapter_code_snapshot
    OR NEW.collection_mode IS DISTINCT FROM OLD.collection_mode
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Payment attempt snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.external_payment_id IS NOT NULL
    AND NEW.external_payment_id IS DISTINCT FROM OLD.external_payment_id
  THEN
    RAISE EXCEPTION 'External payment ID is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.checkout_reference IS NOT NULL
    AND NEW.checkout_reference IS DISTINCT FROM OLD.checkout_reference
  THEN
    RAISE EXCEPTION 'Checkout reference is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'initialized' AND NEW.status IN (
      'pending', 'succeeded', 'failed', 'expired', 'cancelled'
    ) THEN
      NULL;
    ELSIF OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed', 'expired', 'cancelled') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Payment attempt status transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'succeeded' AND OLD.status <> 'succeeded' AND NOT EXISTS (
    SELECT 1
    FROM payment_transactions AS payment_transaction
    WHERE payment_transaction.tenant_id = NEW.tenant_id
      AND payment_transaction.attempt_id = NEW.id
      AND payment_transaction.order_id = NEW.order_id
      AND payment_transaction.provider_id = NEW.provider_id
      AND payment_transaction.transaction_type = 'charge'
      AND payment_transaction.status = 'succeeded'
      AND payment_transaction.currency = NEW.currency
      AND payment_transaction.amount_minor = NEW.amount_minor
  ) THEN
    RAISE EXCEPTION 'Succeeded attempts require a matching succeeded charge transaction'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TABLE IF NOT EXISTS payment_webhook_inbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  payment_config_id uuid NOT NULL,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  payload_json jsonb NOT NULL,
  signature_verified boolean NOT NULL,
  status text NOT NULL DEFAULT 'received',
  attempt_id uuid,
  processed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_webhook_inbox_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_inbox_provider_fk FOREIGN KEY (provider_id)
    REFERENCES payment_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_inbox_config_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_inbox_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES payment_attempts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_inbox_event_unique UNIQUE (
    payment_config_id, external_event_id
  ),
  CONSTRAINT payment_webhook_inbox_event_id_check CHECK (
    char_length(external_event_id) BETWEEN 3 AND 300
  ),
  CONSTRAINT payment_webhook_inbox_event_type_check CHECK (
    event_type ~ '^[a-z][a-z0-9_.-]{2,99}$'
  ),
  CONSTRAINT payment_webhook_inbox_hash_check CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_webhook_inbox_payload_check CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT payment_webhook_inbox_signature_check CHECK (signature_verified),
  CONSTRAINT payment_webhook_inbox_status_check CHECK (
    status IN ('received', 'processed', 'rejected', 'failed')
  ),
  CONSTRAINT payment_webhook_inbox_lifecycle_check CHECK (
    (status = 'received' AND processed_at IS NULL AND error_message IS NULL)
    OR (status = 'processed' AND processed_at IS NOT NULL AND error_message IS NULL)
    OR (
      status IN ('rejected', 'failed')
      AND processed_at IS NOT NULL
      AND error_message IS NOT NULL
      AND char_length(btrim(error_message)) BETWEEN 1 AND 2000
    )
  ),
  CONSTRAINT payment_webhook_inbox_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS payment_webhook_inbox_status_idx
  ON payment_webhook_inbox (status, created_at, id);
CREATE INDEX IF NOT EXISTS payment_webhook_inbox_attempt_idx
  ON payment_webhook_inbox (tenant_id, attempt_id, created_at DESC);

DROP TRIGGER IF EXISTS payment_webhook_inbox_set_updated_at ON payment_webhook_inbox;
CREATE TRIGGER payment_webhook_inbox_set_updated_at
BEFORE UPDATE ON payment_webhook_inbox
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS payment_webhook_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  inbox_id uuid NOT NULL,
  event_type text NOT NULL,
  event_key text NOT NULL UNIQUE,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  locked_at timestamptz,
  locked_by text,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_webhook_outbox_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_outbox_inbox_fk FOREIGN KEY (inbox_id)
    REFERENCES payment_webhook_inbox (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_webhook_outbox_event_type_check CHECK (
    event_type ~ '^[A-Z][A-Za-z0-9]{2,99}$'
  ),
  CONSTRAINT payment_webhook_outbox_event_key_check CHECK (
    char_length(event_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT payment_webhook_outbox_payload_check CHECK (jsonb_typeof(payload_json) = 'object'),
  CONSTRAINT payment_webhook_outbox_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter')
  ),
  CONSTRAINT payment_webhook_outbox_attempts_check CHECK (
    attempts BETWEEN 0 AND 20
  ),
  CONSTRAINT payment_webhook_outbox_lock_check CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT payment_webhook_outbox_delivery_check CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL)
    OR (status <> 'delivered' AND delivered_at IS NULL)
  ),
  CONSTRAINT payment_webhook_outbox_error_check CHECK (
    (status IN ('retry', 'dead_letter') AND last_error IS NOT NULL)
    OR (status NOT IN ('retry', 'dead_letter') AND last_error IS NULL)
  ),
  CONSTRAINT payment_webhook_outbox_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS payment_webhook_outbox_due_idx
  ON payment_webhook_outbox (available_at, created_at, id)
  WHERE status IN ('pending', 'retry');

DROP TRIGGER IF EXISTS payment_webhook_outbox_set_updated_at ON payment_webhook_outbox;
CREATE TRIGGER payment_webhook_outbox_set_updated_at
BEFORE UPDATE ON payment_webhook_outbox
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS payment_refunds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  payment_transaction_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested',
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  reason text NOT NULL,
  external_refund_id text,
  requested_by_type text NOT NULL,
  requested_by uuid NOT NULL,
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT payment_refunds_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_attempt_fk FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES payment_attempts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_transaction_fk FOREIGN KEY (payment_transaction_id)
    REFERENCES payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_refunds_status_check CHECK (
    status IN ('requested', 'processing', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT payment_refunds_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT payment_refunds_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT payment_refunds_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT payment_refunds_external_check CHECK (
    external_refund_id IS NULL OR char_length(external_refund_id) BETWEEN 3 AND 300
  ),
  CONSTRAINT payment_refunds_actor_check CHECK (
    requested_by_type IN ('platform_staff', 'tenant_staff')
  ),
  CONSTRAINT payment_refunds_completion_check CHECK (
    (status = 'succeeded' AND succeeded_at IS NOT NULL AND failed_at IS NULL)
    OR (status = 'failed' AND succeeded_at IS NULL AND failed_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed') AND succeeded_at IS NULL AND failed_at IS NULL)
  ),
  CONSTRAINT payment_refunds_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_external_unique_idx
  ON payment_refunds (external_refund_id) WHERE external_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_refunds_order_idx
  ON payment_refunds (tenant_id, order_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS payment_refunds_set_updated_at ON payment_refunds;
CREATE TRIGGER payment_refunds_set_updated_at
BEFORE UPDATE ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS merchant_balance_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  currency text NOT NULL,
  pending_minor bigint NOT NULL DEFAULT 0,
  available_minor bigint NOT NULL DEFAULT 0,
  frozen_minor bigint NOT NULL DEFAULT 0,
  withdrawn_minor bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT merchant_balance_accounts_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT merchant_balance_accounts_unique UNIQUE (tenant_id, currency),
  CONSTRAINT merchant_balance_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT merchant_balance_accounts_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT merchant_balance_accounts_amounts_check CHECK (
    pending_minor BETWEEN 0 AND 9000000000000000
    AND available_minor BETWEEN 0 AND 9000000000000000
    AND frozen_minor BETWEEN 0 AND available_minor
    AND withdrawn_minor BETWEEN 0 AND 9000000000000000
  ),
  CONSTRAINT merchant_balance_accounts_version_check CHECK (version >= 0),
  CONSTRAINT merchant_balance_accounts_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS merchant_balance_accounts_set_updated_at
  ON merchant_balance_accounts;
CREATE TRIGGER merchant_balance_accounts_set_updated_at
BEFORE UPDATE ON merchant_balance_accounts
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.prevent_direct_merchant_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pending_minor <> 0 OR NEW.available_minor <> 0
      OR NEW.frozen_minor <> 0 OR NEW.withdrawn_minor <> 0
    THEN
      RAISE EXCEPTION 'New merchant balances must start at zero' USING ERRCODE = '42501';
    END IF;
  ELSIF pg_trigger_depth() < 2 AND (
    NEW.pending_minor IS DISTINCT FROM OLD.pending_minor
    OR NEW.available_minor IS DISTINCT FROM OLD.available_minor
    OR NEW.frozen_minor IS DISTINCT FROM OLD.frozen_minor
    OR NEW.withdrawn_minor IS DISTINCT FROM OLD.withdrawn_minor
  ) THEN
    RAISE EXCEPTION 'Merchant balances may only be changed by ledger entries'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS merchant_balance_accounts_enforce_initial
  ON merchant_balance_accounts;
CREATE TRIGGER merchant_balance_accounts_enforce_initial
BEFORE INSERT ON merchant_balance_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_merchant_balance_update();

DROP TRIGGER IF EXISTS merchant_balance_accounts_prevent_direct_update
  ON merchant_balance_accounts;
CREATE TRIGGER merchant_balance_accounts_prevent_direct_update
BEFORE UPDATE OF pending_minor, available_minor, frozen_minor, withdrawn_minor
ON merchant_balance_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_merchant_balance_update();

CREATE TABLE IF NOT EXISTS merchant_balance_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  balance_account_id uuid NOT NULL,
  bucket text NOT NULL,
  entry_type text NOT NULL,
  delta_minor bigint NOT NULL,
  balance_after_minor bigint NOT NULL,
  currency text NOT NULL,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by_type text NOT NULL DEFAULT 'system',
  created_by uuid,
  CONSTRAINT merchant_balance_ledger_account_fk FOREIGN KEY (
    tenant_id, balance_account_id
  ) REFERENCES merchant_balance_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT merchant_balance_ledger_idempotency_unique UNIQUE (
    tenant_id, idempotency_key
  ),
  CONSTRAINT merchant_balance_ledger_bucket_check CHECK (
    bucket IN ('pending', 'available', 'frozen', 'withdrawn')
  ),
  CONSTRAINT merchant_balance_ledger_entry_type_check CHECK (
    entry_type IN (
      'payment_pending', 'settlement_available', 'freeze', 'unfreeze',
      'withdrawal', 'refund', 'adjustment'
    )
  ),
  CONSTRAINT merchant_balance_ledger_delta_check CHECK (
    delta_minor <> 0
    AND delta_minor BETWEEN -9000000000000000 AND 9000000000000000
  ),
  CONSTRAINT merchant_balance_ledger_after_check CHECK (
    balance_after_minor BETWEEN 0 AND 9000000000000000
  ),
  CONSTRAINT merchant_balance_ledger_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT merchant_balance_ledger_reference_type_check CHECK (
    reference_type ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  CONSTRAINT merchant_balance_ledger_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT merchant_balance_ledger_actor_check CHECK (
    created_by_type IN ('system', 'platform_staff', 'tenant_staff')
    AND (created_by_type = 'system' OR created_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS merchant_balance_ledger_history_idx
  ON merchant_balance_ledger (tenant_id, currency, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION app.apply_merchant_balance_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  account merchant_balance_accounts%ROWTYPE;
  current_balance bigint;
  next_balance bigint;
BEGIN
  IF NEW.reference_type = 'payment_transaction' AND (
    NEW.entry_type <> 'payment_pending'
    OR NEW.bucket <> 'pending'
    OR NEW.delta_minor <= 0
    OR NOT EXISTS (
      SELECT 1
      FROM payment_transactions AS payment_transaction
      INNER JOIN payment_attempts AS attempt
        ON attempt.id = payment_transaction.attempt_id
        AND attempt.tenant_id = payment_transaction.tenant_id
      INNER JOIN orders AS commerce_order
        ON commerce_order.id = payment_transaction.order_id
        AND commerce_order.tenant_id = payment_transaction.tenant_id
      WHERE payment_transaction.id = NEW.reference_id
        AND payment_transaction.tenant_id = NEW.tenant_id
        AND payment_transaction.transaction_type = 'charge'
        AND payment_transaction.status = 'succeeded'
        AND payment_transaction.currency = NEW.currency
        AND payment_transaction.amount_minor = NEW.delta_minor
        AND attempt.collection_mode = 'platform_collect'
        AND attempt.status = 'succeeded'
        AND commerce_order.status = 'paid'
    )
  ) THEN
    RAISE EXCEPTION 'Merchant payment ledger entry is not backed by a platform-collected charge'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO account
  FROM merchant_balance_accounts
  WHERE tenant_id = NEW.tenant_id
    AND id = NEW.balance_account_id
    AND currency = NEW.currency
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Merchant balance account does not exist' USING ERRCODE = '23503';
  END IF;

  current_balance := CASE NEW.bucket
    WHEN 'pending' THEN account.pending_minor
    WHEN 'available' THEN account.available_minor
    WHEN 'frozen' THEN account.frozen_minor
    ELSE account.withdrawn_minor
  END;
  BEGIN
    next_balance := current_balance + NEW.delta_minor;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Merchant balance overflow' USING ERRCODE = '22003';
  END;
  IF next_balance < 0 OR next_balance > 9000000000000000 THEN
    RAISE EXCEPTION 'Merchant balance would be outside its allowed range'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.bucket = 'frozen' AND next_balance > account.available_minor THEN
    RAISE EXCEPTION 'Frozen balance cannot exceed available balance'
      USING ERRCODE = '23514';
  END IF;

  NEW.balance_after_minor := next_balance;
  UPDATE merchant_balance_accounts
  SET
    pending_minor = CASE WHEN NEW.bucket = 'pending' THEN next_balance ELSE pending_minor END,
    available_minor = CASE WHEN NEW.bucket = 'available' THEN next_balance ELSE available_minor END,
    frozen_minor = CASE WHEN NEW.bucket = 'frozen' THEN next_balance ELSE frozen_minor END,
    withdrawn_minor = CASE WHEN NEW.bucket = 'withdrawn' THEN next_balance ELSE withdrawn_minor END,
    version = version + 1
  WHERE id = account.id;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS merchant_balance_ledger_apply ON merchant_balance_ledger;
CREATE TRIGGER merchant_balance_ledger_apply
BEFORE INSERT ON merchant_balance_ledger
FOR EACH ROW EXECUTE FUNCTION app.apply_merchant_balance_ledger_entry();

CREATE OR REPLACE FUNCTION app.apply_point_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_account point_accounts%ROWTYPE;
  next_balance bigint;
BEGIN
  IF NEW.entry_type = 'topup' AND NEW.reference_type = 'payment_transaction'
    AND NOT EXISTS (
      SELECT 1
      FROM payment_transactions AS payment_transaction
      INNER JOIN payment_attempts AS attempt
        ON attempt.id = payment_transaction.attempt_id
        AND attempt.tenant_id = payment_transaction.tenant_id
      INNER JOIN orders AS commerce_order
        ON commerce_order.id = payment_transaction.order_id
        AND commerce_order.tenant_id = payment_transaction.tenant_id
      INNER JOIN order_items AS item
        ON item.order_id = commerce_order.id
        AND item.tenant_id = commerce_order.tenant_id
        AND item.line_no = 1
      WHERE payment_transaction.id = NEW.reference_id
        AND payment_transaction.tenant_id = NEW.tenant_id
        AND payment_transaction.transaction_type = 'charge'
        AND payment_transaction.status = 'succeeded'
        AND attempt.account_id = NEW.account_id
        AND attempt.status = 'succeeded'
        AND commerce_order.account_id = NEW.account_id
        AND commerce_order.status = 'paid'
        AND commerce_order.order_type = 'points_topup'
        AND item.item_type = 'points_topup'
        AND (item.product_snapshot_json ->> 'pointsAmount') ~ '^[0-9]{1,16}$'
        AND coalesce(item.product_snapshot_json ->> 'bonusPoints', '0') ~ '^[0-9]{1,16}$'
        AND NEW.delta =
          (item.product_snapshot_json ->> 'pointsAmount')::bigint
          + coalesce(item.product_snapshot_json ->> 'bonusPoints', '0')::bigint
    )
  THEN
    RAISE EXCEPTION 'Point topup is not backed by the customer paid points order'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO current_account
  FROM point_accounts
  WHERE tenant_id = NEW.tenant_id
    AND account_id = NEW.account_id
    AND id = NEW.point_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Point account does not exist' USING ERRCODE = '23503';
  END IF;

  BEGIN
    next_balance := current_account.balance + NEW.delta;
  EXCEPTION WHEN numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Point balance overflow' USING ERRCODE = '22003';
  END;
  IF next_balance < 0 OR next_balance > 9000000000000000 THEN
    RAISE EXCEPTION 'Point balance would be outside its allowed range'
      USING ERRCODE = '23514';
  END IF;

  NEW.balance_after := next_balance;
  UPDATE point_accounts
  SET balance = next_balance, version = version + 1
  WHERE id = current_account.id;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS merchant_balance_ledger_prevent_mutation
  ON merchant_balance_ledger;
CREATE TRIGGER merchant_balance_ledger_prevent_mutation
BEFORE UPDATE OR DELETE ON merchant_balance_ledger
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_paid_order_has_succeeded_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'paid' AND OLD.status <> 'paid' AND NOT EXISTS (
    SELECT 1
    FROM payment_attempts AS attempt
    WHERE attempt.tenant_id = NEW.tenant_id
      AND attempt.order_id = NEW.id
      AND attempt.account_id = NEW.account_id
      AND attempt.status = 'succeeded'
      AND attempt.currency = NEW.currency
      AND attempt.amount_minor = NEW.total_minor
  ) THEN
    RAISE EXCEPTION 'Paid orders require a matching succeeded payment attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS orders_enforce_succeeded_payment ON orders;
CREATE TRIGGER orders_enforce_succeeded_payment
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION app.enforce_paid_order_has_succeeded_payment();

CREATE OR REPLACE FUNCTION app.enforce_payment_order_time_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'pending_payment' AND NEW.status = 'expired'
    AND transaction_timestamp() < OLD.expires_at
  THEN
    RAISE EXCEPTION 'Pending orders cannot expire before expires_at'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'pending_payment' AND NEW.status = 'paid' AND (
    NEW.paid_at IS NULL
    OR NEW.paid_at < OLD.created_at
    OR NEW.paid_at > OLD.expires_at
    OR transaction_timestamp() >= OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'Expired pending orders cannot be paid or use an invalid paid_at'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.protect_order_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.order_no IS DISTINCT FROM OLD.order_no
    OR NEW.order_type IS DISTINCT FROM OLD.order_type
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.customer_snapshot_json IS DISTINCT FROM OLD.customer_snapshot_json
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Order commercial snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending_payment' AND NEW.status = 'paid' THEN
      IF OLD.expires_at <= transaction_timestamp() THEN
        RAISE EXCEPTION 'Expired pending orders cannot be paid' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'pending_payment' AND NEW.status IN ('expired', 'cancelled') THEN
      NULL;
    ELSIF OLD.status = 'paid' AND NEW.status = 'refunded' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Order status transition is not allowed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS orders_enforce_payment_time ON orders;
CREATE TRIGGER orders_enforce_payment_time
BEFORE UPDATE OF status, paid_at ON orders
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_order_time_transition();

ALTER TABLE payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_providers_tenant_select ON payment_providers;
CREATE POLICY payment_providers_tenant_select ON payment_providers FOR SELECT
  USING (status = 'active' AND app.current_tenant_id() IS NOT NULL);
DROP POLICY IF EXISTS payment_providers_platform_access ON payment_providers;
CREATE POLICY payment_providers_platform_access ON payment_providers FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_configs_tenant_select ON payment_configs;
CREATE POLICY payment_configs_tenant_select ON payment_configs FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND status = 'active' AND app.current_tenant_id() IS NOT NULL)
  );
DROP POLICY IF EXISTS payment_configs_tenant_insert ON payment_configs;
CREATE POLICY payment_configs_tenant_insert ON payment_configs FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_configs_tenant_update ON payment_configs;
CREATE POLICY payment_configs_tenant_update ON payment_configs FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_configs_platform_access ON payment_configs;
CREATE POLICY payment_configs_platform_access ON payment_configs FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_config_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_config_secrets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_config_secrets_tenant_access ON payment_config_secrets;
CREATE POLICY payment_config_secrets_tenant_access ON payment_config_secrets FOR ALL
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_config_secrets_platform_access ON payment_config_secrets;
CREATE POLICY payment_config_secrets_platform_access ON payment_config_secrets FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_payment_routing ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_payment_routing FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_payment_routing_tenant_access ON tenant_payment_routing;
CREATE POLICY tenant_payment_routing_tenant_access ON tenant_payment_routing FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_payment_routing_platform_access ON tenant_payment_routing;
CREATE POLICY tenant_payment_routing_platform_access ON tenant_payment_routing FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_attempts_tenant_access ON payment_attempts;
CREATE POLICY payment_attempts_tenant_access ON payment_attempts FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_attempts_platform_access ON payment_attempts;
CREATE POLICY payment_attempts_platform_access ON payment_attempts FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_transactions_tenant_access ON payment_transactions;
CREATE POLICY payment_transactions_tenant_access ON payment_transactions FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_transactions_platform_access ON payment_transactions;
CREATE POLICY payment_transactions_platform_access ON payment_transactions FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_webhook_inbox_tenant_access ON payment_webhook_inbox;
CREATE POLICY payment_webhook_inbox_tenant_access ON payment_webhook_inbox FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_webhook_inbox_platform_access ON payment_webhook_inbox;
CREATE POLICY payment_webhook_inbox_platform_access ON payment_webhook_inbox FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_webhook_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_webhook_outbox_tenant_access ON payment_webhook_outbox;
CREATE POLICY payment_webhook_outbox_tenant_access ON payment_webhook_outbox FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_webhook_outbox_platform_access ON payment_webhook_outbox;
CREATE POLICY payment_webhook_outbox_platform_access ON payment_webhook_outbox FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE payment_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_refunds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_refunds_tenant_access ON payment_refunds;
CREATE POLICY payment_refunds_tenant_access ON payment_refunds FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS payment_refunds_platform_access ON payment_refunds;
CREATE POLICY payment_refunds_platform_access ON payment_refunds FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE merchant_balance_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_balance_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchant_balance_accounts_tenant_access ON merchant_balance_accounts;
CREATE POLICY merchant_balance_accounts_tenant_access ON merchant_balance_accounts FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS merchant_balance_accounts_platform_access ON merchant_balance_accounts;
CREATE POLICY merchant_balance_accounts_platform_access ON merchant_balance_accounts FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE merchant_balance_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_balance_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchant_balance_ledger_tenant_access ON merchant_balance_ledger;
CREATE POLICY merchant_balance_ledger_tenant_access ON merchant_balance_ledger FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS merchant_balance_ledger_platform_access ON merchant_balance_ledger;
CREATE POLICY merchant_balance_ledger_platform_access ON merchant_balance_ledger FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.enforce_fake_payment_config_credentials() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_provider_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_config_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_routing_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_attempt_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_transaction_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_direct_merchant_balance_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_merchant_balance_ledger_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_paid_order_has_succeeded_payment() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_order_time_transition() FROM PUBLIC;

COMMIT;
