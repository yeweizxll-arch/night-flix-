BEGIN;

ALTER TABLE payment_configs
  ADD COLUMN IF NOT EXISTS provider_mode text,
  ADD COLUMN IF NOT EXISTS provider_account_id text,
  ADD COLUMN IF NOT EXISTS active_secret_version integer,
  ADD COLUMN IF NOT EXISTS last_test_status text,
  ADD COLUMN IF NOT EXISTS last_tested_secret_version integer,
  ADD COLUMN IF NOT EXISTS last_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_test_error text;

ALTER TABLE payment_configs
  DROP CONSTRAINT IF EXISTS payment_configs_provider_mode_check,
  ADD CONSTRAINT payment_configs_provider_mode_check CHECK (
    provider_mode IS NULL OR provider_mode IN ('test', 'live')
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_provider_account_check,
  ADD CONSTRAINT payment_configs_provider_account_check CHECK (
    provider_account_id IS NULL OR provider_account_id ~ '^acct_[A-Za-z0-9]{8,64}$'
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_active_secret_check,
  ADD CONSTRAINT payment_configs_active_secret_check CHECK (
    active_secret_version IS NULL OR active_secret_version > 0
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_test_status_check,
  ADD CONSTRAINT payment_configs_test_status_check CHECK (
    last_test_status IS NULL OR last_test_status IN ('untested', 'passed', 'failed')
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_test_version_check,
  ADD CONSTRAINT payment_configs_test_version_check CHECK (
    last_tested_secret_version IS NULL OR last_tested_secret_version > 0
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_test_error_check,
  ADD CONSTRAINT payment_configs_test_error_check CHECK (
    last_test_error IS NULL OR last_test_error IN (
      'provider_auth_failed', 'provider_account_mismatch',
      'provider_unavailable', 'provider_invalid_response'
    )
  ),
  DROP CONSTRAINT IF EXISTS payment_configs_test_result_check,
  ADD CONSTRAINT payment_configs_test_result_check CHECK (
    (
      last_test_status IS NULL AND last_tested_secret_version IS NULL
      AND last_test_at IS NULL AND last_test_error IS NULL
    ) OR (
      last_test_status = 'untested' AND last_tested_secret_version IS NULL
      AND last_test_at IS NULL AND last_test_error IS NULL
    ) OR (
      last_test_status = 'passed' AND last_tested_secret_version IS NOT NULL
      AND last_test_at IS NOT NULL AND last_test_error IS NULL
    ) OR (
      last_test_status = 'failed' AND last_tested_secret_version IS NOT NULL
      AND last_test_at IS NOT NULL AND last_test_error IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS payment_config_secret_versions (
  id uuid PRIMARY KEY,
  payment_config_id uuid NOT NULL,
  owner_type text NOT NULL,
  owner_tenant_id uuid,
  secret_version integer NOT NULL,
  provider_mode text NOT NULL,
  provider_account_id text NOT NULL,
  secret_key_ciphertext text NOT NULL,
  webhook_secret_ciphertext text NOT NULL,
  credential_key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  verify_webhooks_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  retired_at timestamptz,
  CONSTRAINT payment_config_secret_versions_config_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_config_secret_versions_scope_fk FOREIGN KEY (
    owner_type, owner_tenant_id, payment_config_id
  ) REFERENCES payment_configs (owner_type, owner_tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT payment_config_secret_versions_unique UNIQUE (
    payment_config_id, secret_version
  ),
  CONSTRAINT payment_config_secret_versions_scope_check CHECK (
    app.valid_content_scope(owner_type, owner_tenant_id)
  ),
  CONSTRAINT payment_config_secret_versions_version_check CHECK (secret_version > 0),
  CONSTRAINT payment_config_secret_versions_mode_check CHECK (
    provider_mode IN ('test', 'live')
  ),
  CONSTRAINT payment_config_secret_versions_account_check CHECK (
    provider_account_id ~ '^acct_[A-Za-z0-9]{8,64}$'
  ),
  CONSTRAINT payment_config_secret_versions_secret_check CHECK (
    char_length(secret_key_ciphertext) BETWEEN 20 AND 16384
    AND char_length(webhook_secret_ciphertext) BETWEEN 20 AND 16384
  ),
  CONSTRAINT payment_config_secret_versions_key_check CHECK (credential_key_version > 0),
  CONSTRAINT payment_config_secret_versions_status_check CHECK (
    status IN ('active', 'grace', 'retired')
  ),
  CONSTRAINT payment_config_secret_versions_lifecycle_check CHECK (
    (
      status = 'active' AND verify_webhooks_until IS NULL AND retired_at IS NULL
    ) OR (
      status = 'grace' AND verify_webhooks_until IS NOT NULL
      AND verify_webhooks_until > created_at AND retired_at IS NULL
    ) OR (
      status = 'retired' AND retired_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_config_secret_versions_one_active_idx
  ON payment_config_secret_versions (payment_config_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS payment_config_secret_versions_webhook_idx
  ON payment_config_secret_versions (
    payment_config_id, status, verify_webhooks_until DESC, secret_version DESC
  );

ALTER TABLE payment_configs
  DROP CONSTRAINT IF EXISTS payment_configs_active_secret_fk,
  ADD CONSTRAINT payment_configs_active_secret_fk FOREIGN KEY (
    id, active_secret_version
  ) REFERENCES payment_config_secret_versions (payment_config_id, secret_version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION app.enforce_payment_secret_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  selected_adapter text;
  selected_mode text;
  selected_account text;
  live_versions integer;
BEGIN
  SELECT provider.adapter_code, config.provider_mode, config.provider_account_id
  INTO selected_adapter, selected_mode, selected_account
  FROM payment_configs AS config
  INNER JOIN payment_providers AS provider ON provider.id = config.provider_id
  WHERE config.id = NEW.payment_config_id
  FOR UPDATE OF config;

  IF selected_adapter <> 'stripe'
    OR selected_mode IS DISTINCT FROM NEW.provider_mode
    OR selected_account IS DISTINCT FROM NEW.provider_account_id
  THEN
    RAISE EXCEPTION 'Stripe secret scope does not match its config'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.payment_config_id IS DISTINCT FROM OLD.payment_config_id
      OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
      OR NEW.owner_tenant_id IS DISTINCT FROM OLD.owner_tenant_id
      OR NEW.secret_version IS DISTINCT FROM OLD.secret_version
      OR NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
      OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
      OR NEW.secret_key_ciphertext IS DISTINCT FROM OLD.secret_key_ciphertext
      OR NEW.webhook_secret_ciphertext IS DISTINCT FROM OLD.webhook_secret_ciphertext
      OR NEW.credential_key_version IS DISTINCT FROM OLD.credential_key_version
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'Payment secret version facts are immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD.status = 'active' AND NEW.status = 'grace'
        AND NEW.verify_webhooks_until > statement_timestamp()
        AND NEW.retired_at IS NULL)
      OR (OLD.status = 'grace' AND NEW.status = 'retired'
        AND NEW.verify_webhooks_until IS NOT DISTINCT FROM OLD.verify_webhooks_until
        AND NEW.retired_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Payment secret version transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status IN ('active', 'grace') THEN
    SELECT count(*) INTO live_versions
    FROM payment_config_secret_versions AS secret
    WHERE secret.payment_config_id = NEW.payment_config_id
      AND secret.status IN ('active', 'grace')
      AND (TG_OP = 'INSERT' OR secret.id <> OLD.id);
    IF live_versions >= 5 THEN
      RAISE EXCEPTION 'At most five active or grace payment secret versions are allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_config_secret_versions_enforce
  ON payment_config_secret_versions;
CREATE TRIGGER payment_config_secret_versions_enforce
BEFORE INSERT OR UPDATE ON payment_config_secret_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_secret_version();

DROP TRIGGER IF EXISTS payment_config_secret_versions_prevent_delete
  ON payment_config_secret_versions;
CREATE TRIGGER payment_config_secret_versions_prevent_delete
BEFORE DELETE ON payment_config_secret_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_payment_config_provider_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  selected_adapter text;
  current_config payment_configs%ROWTYPE;
BEGIN
  SELECT * INTO current_config FROM payment_configs WHERE id = NEW.id;
  SELECT adapter_code INTO selected_adapter
  FROM payment_providers WHERE id = current_config.provider_id;

  IF selected_adapter = 'stripe' THEN
    IF current_config.provider_mode IS NULL OR current_config.provider_account_id IS NULL
      OR current_config.active_secret_version IS NULL OR current_config.last_test_status IS NULL
    THEN
      RAISE EXCEPTION 'Stripe payment config is incomplete' USING ERRCODE = '23514';
    END IF;
    IF current_config.status = 'active' AND (
      current_config.last_test_status <> 'passed'
      OR current_config.last_tested_secret_version
        IS DISTINCT FROM current_config.active_secret_version
    ) THEN
      RAISE EXCEPTION 'Stripe payment config must pass testing before enablement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF current_config.provider_mode IS NOT NULL OR current_config.provider_account_id IS NOT NULL
    OR current_config.active_secret_version IS NOT NULL
    OR current_config.last_test_status IS NOT NULL
    OR current_config.last_tested_secret_version IS NOT NULL
    OR current_config.last_test_at IS NOT NULL
    OR current_config.last_test_error IS NOT NULL
  THEN
    RAISE EXCEPTION 'Non-Stripe payment config cannot contain Stripe state'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.provider_mode IS NOT NULL AND (
      NEW.provider_mode IS DISTINCT FROM OLD.provider_mode
      OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
    ) THEN
      RAISE EXCEPTION 'Payment provider mode and receiving account are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.active_secret_version IS DISTINCT FROM OLD.active_secret_version AND (
      NEW.status <> 'disabled' OR NEW.last_test_status <> 'untested'
      OR NEW.last_tested_secret_version IS NOT NULL OR NEW.last_test_at IS NOT NULL
      OR NEW.last_test_error IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Credential rotation must disable and clear config testing state'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_configs_enforce_provider_state ON payment_configs;
CREATE CONSTRAINT TRIGGER payment_configs_enforce_provider_state
AFTER INSERT OR UPDATE ON payment_configs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_config_provider_state();

ALTER TABLE payment_attempts
  ADD COLUMN IF NOT EXISTS payment_config_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_secret_version integer;

ALTER TABLE payment_attempts
  DROP CONSTRAINT IF EXISTS payment_attempts_config_version_check,
  ADD CONSTRAINT payment_attempts_config_version_check CHECK (payment_config_version >= 0),
  DROP CONSTRAINT IF EXISTS payment_attempts_secret_version_check,
  ADD CONSTRAINT payment_attempts_secret_version_check CHECK (
    payment_secret_version IS NULL OR payment_secret_version > 0
  );

CREATE OR REPLACE FUNCTION app.enforce_payment_attempt_stripe_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  selected_adapter text;
  selected_config_version integer;
  selected_secret_version integer;
BEGIN
  SELECT provider.adapter_code, config.version, config.active_secret_version
  INTO selected_adapter, selected_config_version, selected_secret_version
  FROM payment_configs AS config
  INNER JOIN payment_providers AS provider ON provider.id = config.provider_id
  WHERE config.id = NEW.payment_config_id;
  IF selected_adapter = 'stripe' AND (
    NEW.payment_config_version <> selected_config_version
    OR NEW.payment_secret_version IS DISTINCT FROM selected_secret_version
  ) THEN
    RAISE EXCEPTION 'Stripe attempt config snapshot is stale' USING ERRCODE = '23514';
  END IF;
  IF selected_adapter <> 'stripe' AND NEW.payment_secret_version IS NOT NULL THEN
    RAISE EXCEPTION 'Non-Stripe attempt cannot reference a Stripe secret version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS payment_attempts_enforce_stripe_snapshot ON payment_attempts;
CREATE TRIGGER payment_attempts_enforce_stripe_snapshot
BEFORE INSERT ON payment_attempts
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_attempt_stripe_snapshot();

ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_completion_check;
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_completion_check CHECK (
  (
    status = 'requested'
    AND processing_at IS NULL AND succeeded_at IS NULL AND failed_at IS NULL
    AND refund_transaction_id IS NULL AND external_refund_id IS NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
  ) OR (
    status = 'processing'
    AND processing_at IS NOT NULL AND succeeded_at IS NULL AND failed_at IS NULL
    AND refund_transaction_id IS NULL AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
    AND (
      (NOT reconciliation_required AND last_error IS NULL)
      OR (reconciliation_required AND last_error IS NOT NULL)
    )
  ) OR (
    status = 'succeeded'
    AND processing_at IS NOT NULL AND succeeded_at IS NOT NULL AND failed_at IS NULL
    AND refund_transaction_id IS NOT NULL AND external_refund_id IS NOT NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
  ) OR (
    status = 'failed'
    AND processing_at IS NOT NULL AND succeeded_at IS NULL AND failed_at IS NOT NULL
    AND refund_transaction_id IS NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NOT NULL AND failure_message IS NOT NULL
    AND last_error IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
  ) OR (
    status = 'manual_reconciliation'
    AND processing_at IS NOT NULL AND succeeded_at IS NOT NULL AND failed_at IS NULL
    AND refund_transaction_id IS NOT NULL AND external_refund_id IS NOT NULL
    AND reconciliation_required AND reconciliation_reason IS NOT NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
    AND merchant_balance_bucket IS NULL
  )
);

CREATE OR REPLACE FUNCTION app.enforce_payment_refund_state()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NOT EXISTS (
      SELECT 1
      FROM orders AS commerce_order
      INNER JOIN payment_attempts AS attempt
        ON attempt.order_id = commerce_order.id
        AND attempt.tenant_id = commerce_order.tenant_id
      INNER JOIN payment_transactions AS charge
        ON charge.id = NEW.payment_transaction_id
        AND charge.tenant_id = attempt.tenant_id
        AND charge.attempt_id = attempt.id
        AND charge.order_id = commerce_order.id
      INNER JOIN payment_configs AS config ON config.id = attempt.payment_config_id
      WHERE commerce_order.id = NEW.order_id
        AND commerce_order.tenant_id = NEW.tenant_id
        AND commerce_order.status = 'paid'
        AND commerce_order.currency = NEW.currency
        AND commerce_order.total_minor = NEW.amount_minor
        AND attempt.id = NEW.attempt_id
        AND attempt.status = 'succeeded'
        AND attempt.provider_id = NEW.provider_id
        AND attempt.payment_config_id = NEW.payment_config_id
        AND attempt.adapter_code_snapshot = NEW.adapter_code_snapshot
        AND attempt.collection_mode = NEW.collection_mode
        AND attempt.currency = NEW.currency
        AND attempt.amount_minor = NEW.amount_minor
        AND attempt.external_payment_id = NEW.external_payment_id_snapshot
        AND charge.transaction_type = 'charge'
        AND charge.status = 'succeeded'
        AND charge.provider_id = NEW.provider_id
        AND charge.currency = NEW.currency
        AND charge.amount_minor = NEW.amount_minor
        AND (
          (
            NEW.collection_mode = 'tenant_direct'
            AND NEW.requested_by_type = 'tenant_staff'
            AND config.owner_type = 'tenant'
            AND config.owner_tenant_id = NEW.tenant_id
            AND EXISTS (
              SELECT 1 FROM tenant_staff AS staff
              WHERE staff.id = NEW.requested_by AND staff.tenant_id = NEW.tenant_id
            )
          ) OR (
            NEW.collection_mode = 'platform_collect'
            AND NEW.requested_by_type = 'platform_staff'
            AND config.owner_type = 'platform'
            AND config.owner_tenant_id IS NULL
            AND EXISTS (
              SELECT 1 FROM platform_staff AS staff WHERE staff.id = NEW.requested_by
            )
          )
        )
    ) THEN
      RAISE EXCEPTION 'Refund does not match its paid charge and collection owner'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Refund version must increase by exactly one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
      OR NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id
      OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
      OR NEW.payment_config_id IS DISTINCT FROM OLD.payment_config_id
      OR NEW.adapter_code_snapshot IS DISTINCT FROM OLD.adapter_code_snapshot
      OR NEW.collection_mode IS DISTINCT FROM OLD.collection_mode
      OR NEW.external_payment_id_snapshot IS DISTINCT FROM OLD.external_payment_id_snapshot
      OR NEW.provider_idempotency_key IS DISTINCT FROM OLD.provider_idempotency_key
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.requested_by_type IS DISTINCT FROM OLD.requested_by_type
      OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Refund request snapshot is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.status IN ('succeeded', 'failed', 'manual_reconciliation') THEN
      RAISE EXCEPTION 'Terminal refund facts are immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.external_refund_id IS NOT NULL
      AND NEW.external_refund_id IS DISTINCT FROM OLD.external_refund_id
    THEN
      RAISE EXCEPTION 'External refund ID is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'requested' AND NEW.status = 'processing' THEN
        NULL;
      ELSIF OLD.status = 'processing'
        AND NEW.status IN ('succeeded', 'failed', 'manual_reconciliation') THEN
        NULL;
      ELSE
        RAISE EXCEPTION 'Refund status transition is not allowed'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'processing'
      AND OLD.external_refund_id IS NULL
      AND NEW.external_refund_id IS NOT NULL
      AND NEW.reconciliation_required IS NOT DISTINCT FROM OLD.reconciliation_required
      AND NEW.last_error IS NOT DISTINCT FROM OLD.last_error
      AND NEW.processing_at IS NOT DISTINCT FROM OLD.processing_at
      AND NEW.succeeded_at IS NOT DISTINCT FROM OLD.succeeded_at
      AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
      AND NEW.refund_transaction_id IS NOT DISTINCT FROM OLD.refund_transaction_id
      AND NEW.reconciliation_reason IS NOT DISTINCT FROM OLD.reconciliation_reason
      AND NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code
      AND NEW.failure_message IS NOT DISTINCT FROM OLD.failure_message
      AND NEW.merchant_balance_account_id IS NOT DISTINCT FROM OLD.merchant_balance_account_id
      AND NEW.merchant_balance_bucket IS NOT DISTINCT FROM OLD.merchant_balance_bucket
    THEN
      NULL;
    ELSIF OLD.status <> 'processing'
      OR OLD.reconciliation_required
      OR NOT NEW.reconciliation_required
      OR NEW.last_error IS NULL
      OR NEW.processing_at IS DISTINCT FROM OLD.processing_at
      OR NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at
      OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
      OR NEW.refund_transaction_id IS DISTINCT FROM OLD.refund_transaction_id
      OR NEW.external_refund_id IS DISTINCT FROM OLD.external_refund_id
      OR NEW.reconciliation_reason IS DISTINCT FROM OLD.reconciliation_reason
      OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
      OR NEW.failure_message IS DISTINCT FROM OLD.failure_message
      OR NEW.merchant_balance_account_id IS DISTINCT FROM OLD.merchant_balance_account_id
      OR NEW.merchant_balance_bucket IS DISTINCT FROM OLD.merchant_balance_bucket
    THEN
      RAISE EXCEPTION 'A processing refund only permits provider binding or reconciliation'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IN ('succeeded', 'manual_reconciliation')
      AND OLD.status = 'processing'
      AND NOT EXISTS (
        SELECT 1 FROM payment_transactions AS refund_transaction
        WHERE refund_transaction.id = NEW.refund_transaction_id
          AND refund_transaction.tenant_id = NEW.tenant_id
          AND refund_transaction.attempt_id = NEW.attempt_id
          AND refund_transaction.order_id = NEW.order_id
          AND refund_transaction.provider_id = NEW.provider_id
          AND refund_transaction.transaction_type = 'refund'
          AND refund_transaction.status = 'succeeded'
          AND refund_transaction.external_transaction_id = NEW.external_refund_id
          AND refund_transaction.currency = NEW.currency
          AND refund_transaction.amount_minor = NEW.amount_minor
      )
    THEN
      RAISE EXCEPTION 'Successful refund requires a matching full refund transaction'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- Replace the final version from 0013 so the two new snapshot fields are immutable.
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
    OR NEW.payment_config_version IS DISTINCT FROM OLD.payment_config_version
    OR NEW.payment_secret_version IS DISTINCT FROM OLD.payment_secret_version
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
    ELSIF OLD.status = 'pending' AND NEW.status IN (
      'succeeded', 'failed', 'expired', 'cancelled'
    ) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Payment attempt status transition is not allowed'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status = 'succeeded' AND OLD.status <> 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM payment_transactions AS payment_transaction
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

-- Existing secret ciphertext must never be visible to tenant database roles.
DROP POLICY IF EXISTS payment_config_secrets_tenant_access ON payment_config_secrets;

ALTER TABLE payment_config_secret_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_config_secret_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_config_secret_versions_platform_access
  ON payment_config_secret_versions;
CREATE POLICY payment_config_secret_versions_platform_access
  ON payment_config_secret_versions FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.enforce_payment_secret_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_config_provider_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_payment_attempt_stripe_snapshot() FROM PUBLIC;

COMMIT;
