BEGIN;

ALTER TABLE payment_refunds
  ADD COLUMN IF NOT EXISTS provider_id uuid,
  ADD COLUMN IF NOT EXISTS payment_config_id uuid,
  ADD COLUMN IF NOT EXISTS refund_transaction_id uuid,
  ADD COLUMN IF NOT EXISTS adapter_code_snapshot text,
  ADD COLUMN IF NOT EXISTS collection_mode text,
  ADD COLUMN IF NOT EXISTS external_payment_id_snapshot text,
  ADD COLUMN IF NOT EXISTS provider_idempotency_key text,
  ADD COLUMN IF NOT EXISTS processing_at timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconciliation_reason text,
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS merchant_balance_account_id uuid,
  ADD COLUMN IF NOT EXISTS merchant_balance_bucket text,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

UPDATE payment_refunds AS refund
SET
  provider_id = attempt.provider_id,
  payment_config_id = attempt.payment_config_id,
  adapter_code_snapshot = attempt.adapter_code_snapshot,
  collection_mode = attempt.collection_mode,
  external_payment_id_snapshot = attempt.external_payment_id,
  provider_idempotency_key = coalesce(refund.provider_idempotency_key, refund.id::text),
  processing_at = CASE
    WHEN refund.status = 'requested' THEN NULL
    ELSE coalesce(refund.processing_at, refund.created_at)
  END
FROM payment_attempts AS attempt
WHERE attempt.id = refund.attempt_id
  AND attempt.tenant_id = refund.tenant_id
  AND refund.provider_id IS NULL;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM payment_refunds WHERE status = 'cancelled') THEN
    RAISE EXCEPTION '0020 cannot migrate cancelled refunds without an explicit reconciliation decision';
  END IF;
END
$block$;

ALTER TABLE payment_refunds
  ALTER COLUMN provider_id SET NOT NULL,
  ALTER COLUMN payment_config_id SET NOT NULL,
  ALTER COLUMN adapter_code_snapshot SET NOT NULL,
  ALTER COLUMN collection_mode SET NOT NULL,
  ALTER COLUMN external_payment_id_snapshot SET NOT NULL,
  ALTER COLUMN provider_idempotency_key SET NOT NULL;

ALTER TABLE payment_refunds
  DROP CONSTRAINT IF EXISTS payment_refunds_provider_fk,
  ADD CONSTRAINT payment_refunds_provider_fk FOREIGN KEY (provider_id)
    REFERENCES payment_providers (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_refunds_config_fk,
  ADD CONSTRAINT payment_refunds_config_fk FOREIGN KEY (payment_config_id)
    REFERENCES payment_configs (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_refunds_refund_transaction_fk,
  ADD CONSTRAINT payment_refunds_refund_transaction_fk FOREIGN KEY (refund_transaction_id)
    REFERENCES payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS payment_refunds_merchant_account_fk,
  ADD CONSTRAINT payment_refunds_merchant_account_fk
    FOREIGN KEY (tenant_id, merchant_balance_account_id)
    REFERENCES merchant_balance_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT;

ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_status_check;
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_status_check CHECK (
  status IN ('requested', 'processing', 'succeeded', 'failed', 'manual_reconciliation')
);
ALTER TABLE payment_refunds DROP CONSTRAINT IF EXISTS payment_refunds_completion_check;
ALTER TABLE payment_refunds ADD CONSTRAINT payment_refunds_completion_check CHECK (
  (
    status = 'requested'
    AND processing_at IS NULL AND succeeded_at IS NULL AND failed_at IS NULL
    AND refund_transaction_id IS NULL AND external_refund_id IS NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
  )
  OR (
    status = 'processing'
    AND processing_at IS NOT NULL AND succeeded_at IS NULL AND failed_at IS NULL
    AND refund_transaction_id IS NULL AND external_refund_id IS NULL
    AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
    AND (
      (NOT reconciliation_required AND last_error IS NULL)
      OR (reconciliation_required AND last_error IS NOT NULL)
    )
  )
  OR (
    status = 'succeeded'
    AND processing_at IS NOT NULL AND succeeded_at IS NOT NULL AND failed_at IS NULL
    AND refund_transaction_id IS NOT NULL AND external_refund_id IS NOT NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
  )
  OR (
    status = 'failed'
    AND processing_at IS NOT NULL AND succeeded_at IS NULL AND failed_at IS NOT NULL
    AND refund_transaction_id IS NULL AND external_refund_id IS NULL
    AND NOT reconciliation_required AND reconciliation_reason IS NULL
    AND failure_code IS NOT NULL AND failure_message IS NOT NULL
    AND last_error IS NULL
    AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL
  )
  OR (
    status = 'manual_reconciliation'
    AND processing_at IS NOT NULL AND succeeded_at IS NOT NULL AND failed_at IS NULL
    AND refund_transaction_id IS NOT NULL AND external_refund_id IS NOT NULL
    AND reconciliation_required AND reconciliation_reason IS NOT NULL
    AND failure_code IS NULL AND failure_message IS NULL AND last_error IS NULL
    AND merchant_balance_bucket IS NULL
  )
);
ALTER TABLE payment_refunds
  DROP CONSTRAINT IF EXISTS payment_refunds_adapter_check,
  ADD CONSTRAINT payment_refunds_adapter_check CHECK (
    adapter_code_snapshot ~ '^[a-z][a-z0-9_-]{1,63}$'
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_collection_check,
  ADD CONSTRAINT payment_refunds_collection_check CHECK (
    collection_mode IN ('platform_collect', 'tenant_direct')
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_external_payment_check,
  ADD CONSTRAINT payment_refunds_external_payment_check CHECK (
    char_length(external_payment_id_snapshot) BETWEEN 3 AND 300
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_provider_key_check,
  ADD CONSTRAINT payment_refunds_provider_key_check CHECK (
    char_length(provider_idempotency_key) BETWEEN 8 AND 200
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_reconciliation_check,
  ADD CONSTRAINT payment_refunds_reconciliation_check CHECK (
    reconciliation_reason IS NULL
    OR char_length(btrim(reconciliation_reason)) BETWEEN 3 AND 2000
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_failure_check,
  ADD CONSTRAINT payment_refunds_failure_check CHECK (
    (failure_code IS NULL AND failure_message IS NULL)
    OR (
      failure_code ~ '^[a-z][a-z0-9_]{1,99}$'
      AND char_length(btrim(failure_message)) BETWEEN 3 AND 2000
    )
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_last_error_check,
  ADD CONSTRAINT payment_refunds_last_error_check CHECK (
    last_error IS NULL OR char_length(btrim(last_error)) BETWEEN 3 AND 2000
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_merchant_bucket_check,
  ADD CONSTRAINT payment_refunds_merchant_bucket_check CHECK (
    merchant_balance_bucket IS NULL OR merchant_balance_bucket IN ('pending', 'available')
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_version_check,
  ADD CONSTRAINT payment_refunds_version_check CHECK (version >= 0),
  DROP CONSTRAINT IF EXISTS payment_refunds_processing_timestamp_check,
  ADD CONSTRAINT payment_refunds_processing_timestamp_check CHECK (
    processing_at IS NULL OR processing_at >= created_at
  ),
  DROP CONSTRAINT IF EXISTS payment_refunds_terminal_timestamp_check,
  ADD CONSTRAINT payment_refunds_terminal_timestamp_check CHECK (
    (succeeded_at IS NULL OR (processing_at IS NOT NULL AND succeeded_at >= processing_at))
    AND (failed_at IS NULL OR (processing_at IS NOT NULL AND failed_at >= processing_at))
  );

DROP INDEX IF EXISTS payment_refunds_external_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_external_unique_idx
  ON payment_refunds (provider_id, external_refund_id)
  WHERE external_refund_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_provider_idempotency_unique_idx
  ON payment_refunds (provider_id, provider_idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS payment_refunds_active_order_unique_idx
  ON payment_refunds (order_id)
  WHERE status IN ('requested', 'processing', 'succeeded', 'manual_reconciliation');
CREATE INDEX IF NOT EXISTS payment_refunds_status_idx
  ON payment_refunds (status, created_at, id);

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
          )
          OR (
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
      RAISE EXCEPTION 'A processing refund only permits its first reconciliation marker'
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

DROP TRIGGER IF EXISTS payment_refunds_enforce_state ON payment_refunds;
CREATE TRIGGER payment_refunds_enforce_state
BEFORE INSERT OR UPDATE ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION app.enforce_payment_refund_state();

DROP TRIGGER IF EXISTS payment_refunds_prevent_delete ON payment_refunds;
CREATE TRIGGER payment_refunds_prevent_delete
BEFORE DELETE ON payment_refunds
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_refunded_order_has_refund()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'refunded' AND OLD.status <> 'refunded' AND NOT EXISTS (
    SELECT 1 FROM payment_refunds AS refund
    INNER JOIN payment_transactions AS refund_transaction
      ON refund_transaction.id = refund.refund_transaction_id
    WHERE refund.tenant_id = NEW.tenant_id
      AND refund.order_id = NEW.id
      AND refund.status IN ('succeeded', 'manual_reconciliation')
      AND refund.currency = NEW.currency
      AND refund.amount_minor = NEW.total_minor
      AND refund_transaction.transaction_type = 'refund'
      AND refund_transaction.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'Refunded orders require a succeeded full refund fact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS orders_enforce_refund_fact ON orders;
CREATE TRIGGER orders_enforce_refund_fact
BEFORE UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION app.enforce_refunded_order_has_refund();

ALTER TABLE merchant_settlements
  ADD COLUMN IF NOT EXISTS payment_refund_id uuid,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE merchant_settlements
  DROP CONSTRAINT IF EXISTS merchant_settlements_refund_fk,
  ADD CONSTRAINT merchant_settlements_refund_fk FOREIGN KEY (payment_refund_id)
    REFERENCES payment_refunds (id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE merchant_settlements DROP CONSTRAINT IF EXISTS merchant_settlements_status_check;
ALTER TABLE merchant_settlements ADD CONSTRAINT merchant_settlements_status_check CHECK (
  status IN ('pending', 'settled', 'refunded')
);
ALTER TABLE merchant_settlements DROP CONSTRAINT IF EXISTS merchant_settlements_lifecycle_check;
ALTER TABLE merchant_settlements ADD CONSTRAINT merchant_settlements_lifecycle_check CHECK (
  (status = 'pending' AND settled_at IS NULL AND payment_refund_id IS NULL AND refunded_at IS NULL)
  OR (
    status = 'settled' AND settled_at IS NOT NULL AND settled_at >= eligible_at
    AND payment_refund_id IS NULL AND refunded_at IS NULL
  )
  OR (
    status = 'refunded' AND payment_refund_id IS NOT NULL AND refunded_at IS NOT NULL
    AND refunded_at >= created_at
  )
);

CREATE OR REPLACE FUNCTION app.enforce_merchant_settlement_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM payment_transactions AS payment_transaction
      INNER JOIN payment_attempts AS attempt
        ON attempt.id = payment_transaction.attempt_id
        AND attempt.tenant_id = payment_transaction.tenant_id
      INNER JOIN orders AS commerce_order
        ON commerce_order.id = payment_transaction.order_id
        AND commerce_order.tenant_id = payment_transaction.tenant_id
      WHERE payment_transaction.id = NEW.payment_transaction_id
        AND payment_transaction.tenant_id = NEW.tenant_id
        AND payment_transaction.transaction_type = 'charge'
        AND payment_transaction.status = 'succeeded'
        AND payment_transaction.currency = NEW.currency
        AND payment_transaction.amount_minor = NEW.amount_minor
        AND attempt.collection_mode = 'platform_collect'
        AND attempt.status = 'succeeded'
        AND commerce_order.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'Settlement is not backed by a platform-collected succeeded charge'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'Settlement version must increase by exactly one'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.balance_account_id IS DISTINCT FROM OLD.balance_account_id
      OR NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
      OR NEW.eligible_at IS DISTINCT FROM OLD.eligible_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Settlement snapshot is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'refunded' THEN
      RAISE EXCEPTION 'Refunded settlement facts are immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'pending' AND NEW.status = 'settled' THEN
        IF transaction_timestamp() < OLD.eligible_at THEN
          RAISE EXCEPTION 'Settlement is not eligible yet' USING ERRCODE = '23514';
        END IF;
      ELSIF OLD.status IN ('pending', 'settled') AND NEW.status = 'refunded' THEN
        IF NOT EXISTS (
          SELECT 1 FROM payment_refunds AS refund
          WHERE refund.id = NEW.payment_refund_id
            AND refund.tenant_id = NEW.tenant_id
            AND refund.payment_transaction_id = NEW.payment_transaction_id
            AND refund.status IN ('succeeded', 'manual_reconciliation')
            AND refund.currency = NEW.currency
            AND refund.amount_minor = NEW.amount_minor
        ) THEN
          RAISE EXCEPTION 'Refunded settlement lacks its full refund fact'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'Settlement status transition is not allowed'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.payment_refund_id IS DISTINCT FROM OLD.payment_refund_id
      OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at
      OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
    THEN
      RAISE EXCEPTION 'Settlement result fields require a status transition'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP INDEX IF EXISTS merchant_balance_ledger_reference_leg_unique_idx;
CREATE UNIQUE INDEX merchant_balance_ledger_reference_leg_unique_idx
  ON merchant_balance_ledger (
    tenant_id, reference_type, reference_id, entry_type, bucket
  )
  WHERE reference_type IN (
    'payment_transaction', 'merchant_settlement', 'withdrawal', 'payment_refund'
  );

ALTER TABLE point_ledger DROP CONSTRAINT IF EXISTS point_ledger_entry_type_check;
ALTER TABLE point_ledger ADD CONSTRAINT point_ledger_entry_type_check CHECK (
  entry_type IN (
    'topup', 'purchase', 'refund', 'adjustment',
    'refund_reserve', 'refund_release'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_payment_refund_leg_unique_idx
  ON point_ledger (tenant_id, account_id, reference_type, reference_id, entry_type)
  WHERE reference_type = 'payment_refund';

ALTER TABLE payment_refunds
  DROP CONSTRAINT IF EXISTS payment_refunds_merchant_scope_check,
  ADD CONSTRAINT payment_refunds_merchant_scope_check CHECK (
    (
      collection_mode = 'tenant_direct'
      AND merchant_balance_account_id IS NULL
      AND merchant_balance_bucket IS NULL
    )
    OR (
      collection_mode = 'platform_collect'
      AND (
        (status IN ('requested', 'processing', 'failed')
          AND merchant_balance_account_id IS NULL AND merchant_balance_bucket IS NULL)
        OR (status = 'succeeded'
          AND merchant_balance_account_id IS NOT NULL AND merchant_balance_bucket IS NOT NULL)
        OR (status = 'manual_reconciliation' AND merchant_balance_bucket IS NULL)
      )
    )
  );

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

  IF NEW.reference_type = 'point_unlock' AND (
    NEW.entry_type <> 'purchase'
    OR NEW.delta >= 0
    OR NEW.created_by_type <> 'user'
    OR NEW.created_by IS DISTINCT FROM NEW.account_id
    OR NOT EXISTS (
      SELECT 1 FROM point_unlocks AS unlock
      WHERE unlock.id = NEW.reference_id
        AND unlock.tenant_id = NEW.tenant_id
        AND unlock.account_id = NEW.account_id
        AND unlock.point_account_id = NEW.point_account_id
        AND NEW.delta = -unlock.points_amount_snapshot
    )
  ) THEN
    RAISE EXCEPTION 'Point purchase is not backed by a matching content unlock'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reference_type = 'payment_refund' AND (
    NEW.created_by_type <> 'system'
    OR NEW.created_by IS NOT NULL
    OR NOT EXISTS (
      SELECT 1
      FROM payment_refunds AS refund
      INNER JOIN orders AS commerce_order
        ON commerce_order.id = refund.order_id
        AND commerce_order.tenant_id = refund.tenant_id
      INNER JOIN order_items AS item
        ON item.order_id = commerce_order.id
        AND item.tenant_id = commerce_order.tenant_id
        AND item.line_no = 1
      WHERE refund.id = NEW.reference_id
        AND refund.tenant_id = NEW.tenant_id
        AND commerce_order.account_id = NEW.account_id
        AND commerce_order.order_type = 'points_topup'
        AND item.item_type = 'points_topup'
        AND (item.product_snapshot_json ->> 'pointsAmount') ~ '^[0-9]{1,16}$'
        AND coalesce(item.product_snapshot_json ->> 'bonusPoints', '0') ~ '^[0-9]{1,16}$'
        AND abs(NEW.delta) =
          (item.product_snapshot_json ->> 'pointsAmount')::bigint
          + coalesce(item.product_snapshot_json ->> 'bonusPoints', '0')::bigint
        AND (
          (NEW.entry_type = 'refund_reserve' AND NEW.delta < 0
            AND refund.status = 'processing')
          OR (NEW.entry_type = 'refund_release' AND NEW.delta > 0
            AND refund.status = 'failed')
        )
    )
  ) THEN
    RAISE EXCEPTION 'Point refund ledger entry is not backed by its full refund state'
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

CREATE OR REPLACE FUNCTION app.validate_finance_ledger_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  settlement merchant_settlements%ROWTYPE;
  withdrawal withdrawals%ROWTYPE;
  refund payment_refunds%ROWTYPE;
BEGIN
  IF NEW.reference_type = 'merchant_settlement' THEN
    SELECT * INTO settlement FROM merchant_settlements
    WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      AND balance_account_id = NEW.balance_account_id AND currency = NEW.currency
    FOR UPDATE;
    IF NOT FOUND OR settlement.status <> 'pending'
      OR settlement.eligible_at > transaction_timestamp()
      OR NEW.entry_type <> 'settlement_available'
      OR (
        NOT (NEW.bucket = 'pending' AND NEW.delta_minor = -settlement.amount_minor)
        AND NOT (NEW.bucket = 'available' AND NEW.delta_minor = settlement.amount_minor)
      )
    THEN
      RAISE EXCEPTION 'Settlement ledger entry does not match a due pending settlement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.reference_type = 'withdrawal' THEN
    SELECT * INTO withdrawal FROM withdrawals
    WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      AND balance_account_id = NEW.balance_account_id AND currency = NEW.currency
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Withdrawal ledger source does not exist' USING ERRCODE = '23503';
    END IF;
    IF NEW.entry_type = 'freeze' THEN
      IF withdrawal.status <> 'submitted' OR (
        NOT (NEW.bucket = 'available' AND NEW.delta_minor = -withdrawal.amount_minor)
        AND NOT (NEW.bucket = 'frozen' AND NEW.delta_minor = withdrawal.amount_minor)
      ) THEN
        RAISE EXCEPTION 'Withdrawal freeze entry is invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.entry_type = 'unfreeze' THEN
      IF withdrawal.status NOT IN ('submitted', 'reviewing', 'approved') OR (
        NOT (NEW.bucket = 'available' AND NEW.delta_minor = withdrawal.amount_minor)
        AND NOT (NEW.bucket = 'frozen' AND NEW.delta_minor = -withdrawal.amount_minor)
      ) THEN
        RAISE EXCEPTION 'Withdrawal unfreeze entry is invalid' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.entry_type = 'withdrawal' THEN
      IF withdrawal.status NOT IN ('approved', 'paying', 'failed') OR (
        NOT (NEW.bucket = 'frozen' AND NEW.delta_minor = -withdrawal.amount_minor)
        AND NOT (NEW.bucket = 'withdrawn' AND NEW.delta_minor = withdrawal.amount_minor)
      ) THEN
        RAISE EXCEPTION 'Withdrawal payout ledger entry is invalid' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Withdrawal ledger entry type is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.reference_type = 'payment_refund' THEN
    SELECT * INTO refund FROM payment_refunds
    WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id
      AND merchant_balance_account_id = NEW.balance_account_id
      AND currency = NEW.currency
    FOR UPDATE;
    IF NOT FOUND
      OR refund.status <> 'succeeded'
      OR refund.collection_mode <> 'platform_collect'
      OR refund.merchant_balance_bucket <> NEW.bucket
      OR NEW.entry_type <> 'refund'
      OR NEW.delta_minor <> -refund.amount_minor
    THEN
      RAISE EXCEPTION 'Merchant refund ledger entry does not match a completed refund'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.require_completed_refund_effects()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  resolved_order_type text;
  topup_points bigint;
BEGIN
  IF NEW.status = 'processing' THEN
    SELECT commerce_order.order_type,
      CASE WHEN commerce_order.order_type = 'points_topup' THEN
        (item.product_snapshot_json ->> 'pointsAmount')::bigint
        + coalesce(item.product_snapshot_json ->> 'bonusPoints', '0')::bigint
      ELSE NULL END
    INTO resolved_order_type, topup_points
    FROM orders AS commerce_order
    INNER JOIN order_items AS item
      ON item.order_id = commerce_order.id
      AND item.tenant_id = commerce_order.tenant_id
      AND item.line_no = 1
    WHERE commerce_order.id = NEW.order_id AND commerce_order.tenant_id = NEW.tenant_id;
    IF resolved_order_type = 'points_topup' AND NOT EXISTS (
      SELECT 1 FROM point_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.account_id = (SELECT account_id FROM orders WHERE id = NEW.order_id)
        AND ledger.reference_type = 'payment_refund'
        AND ledger.reference_id = NEW.id
        AND ledger.entry_type = 'refund_reserve'
        AND ledger.delta = -topup_points
    ) THEN
      RAISE EXCEPTION 'Processing points refund must reserve all granted points'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status = 'failed' THEN
    SELECT commerce_order.order_type,
      CASE WHEN commerce_order.order_type = 'points_topup' THEN
        (item.product_snapshot_json ->> 'pointsAmount')::bigint
        + coalesce(item.product_snapshot_json ->> 'bonusPoints', '0')::bigint
      ELSE NULL END
    INTO resolved_order_type, topup_points
    FROM orders AS commerce_order
    INNER JOIN order_items AS item
      ON item.order_id = commerce_order.id
      AND item.tenant_id = commerce_order.tenant_id
      AND item.line_no = 1
    WHERE commerce_order.id = NEW.order_id AND commerce_order.tenant_id = NEW.tenant_id;
    IF resolved_order_type = 'points_topup' AND NOT EXISTS (
      SELECT 1 FROM point_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.reference_type = 'payment_refund'
        AND ledger.reference_id = NEW.id
        AND ledger.entry_type = 'refund_release'
        AND ledger.delta = topup_points
    ) THEN
      RAISE EXCEPTION 'Failed points refund must release all reserved points'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status NOT IN ('succeeded', 'manual_reconciliation') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM orders AS commerce_order
    WHERE commerce_order.id = NEW.order_id
      AND commerce_order.tenant_id = NEW.tenant_id
      AND commerce_order.status = 'refunded'
      AND commerce_order.refunded_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Completed refund must transition its order to refunded'
      USING ERRCODE = '23514';
  END IF;

  SELECT commerce_order.order_type INTO resolved_order_type
  FROM orders AS commerce_order WHERE commerce_order.id = NEW.order_id;
  IF resolved_order_type = 'points_topup' THEN
    IF NOT EXISTS (
      SELECT 1 FROM point_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.reference_type = 'payment_refund'
        AND ledger.reference_id = NEW.id
        AND ledger.entry_type = 'refund_reserve'
    ) THEN
      RAISE EXCEPTION 'Completed points refund is missing its point reversal'
        USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM entitlements AS entitlement
    WHERE entitlement.tenant_id = NEW.tenant_id
      AND entitlement.source_type = 'order'
      AND entitlement.source_order_id = NEW.order_id
      AND entitlement.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Completed refund still has an active order entitlement'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.collection_mode = 'platform_collect' THEN
    IF NEW.status = 'succeeded' AND NOT EXISTS (
      SELECT 1 FROM merchant_settlements AS settlement
      WHERE settlement.payment_transaction_id = NEW.payment_transaction_id
        AND settlement.payment_refund_id = NEW.id
        AND settlement.status = 'refunded'
    ) THEN
      RAISE EXCEPTION 'Platform-collected refund must close its merchant settlement'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'manual_reconciliation' AND EXISTS (
      SELECT 1 FROM merchant_settlements AS settlement
      WHERE settlement.payment_transaction_id = NEW.payment_transaction_id
        AND (
          settlement.status <> 'refunded'
          OR settlement.payment_refund_id IS DISTINCT FROM NEW.id
        )
    ) THEN
      RAISE EXCEPTION 'Manual reconciliation must close an existing merchant settlement'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'succeeded' AND NOT EXISTS (
      SELECT 1 FROM merchant_balance_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.reference_type = 'payment_refund'
        AND ledger.reference_id = NEW.id
        AND ledger.entry_type = 'refund'
        AND ledger.delta_minor = -NEW.amount_minor
    ) THEN
      RAISE EXCEPTION 'Succeeded platform refund is missing its merchant balance debit'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM referral_commissions AS commission
    WHERE commission.tenant_id = NEW.tenant_id
      AND commission.order_id = NEW.order_id
      AND commission.status <> 'reversed'
  ) THEN
    RAISE EXCEPTION 'Completed refund must reverse its direct referral commission'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS payment_refunds_require_effects ON payment_refunds;
CREATE CONSTRAINT TRIGGER payment_refunds_require_effects
AFTER INSERT OR UPDATE OF status ON payment_refunds
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.require_completed_refund_effects();

DROP POLICY IF EXISTS payment_refunds_tenant_access ON payment_refunds;
CREATE POLICY payment_refunds_tenant_access ON payment_refunds FOR SELECT
  USING (tenant_id = app.current_tenant_id());

REVOKE ALL ON FUNCTION app.enforce_payment_refund_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_refunded_order_has_refund() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_completed_refund_effects() FROM PUBLIC;

COMMIT;
