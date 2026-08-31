BEGIN;

ALTER TABLE merchant_balance_accounts
  DROP CONSTRAINT IF EXISTS merchant_balance_accounts_amounts_check;
ALTER TABLE merchant_balance_accounts
  ADD CONSTRAINT merchant_balance_accounts_amounts_check CHECK (
    pending_minor BETWEEN 0 AND 9000000000000000
    AND available_minor BETWEEN 0 AND 9000000000000000
    AND frozen_minor BETWEEN 0 AND 9000000000000000
    AND withdrawn_minor BETWEEN 0 AND 9000000000000000
  );

CREATE TABLE IF NOT EXISTS tenant_settlement_policies (
  tenant_id uuid NOT NULL,
  currency text NOT NULL,
  delay_days integer NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid,
  CONSTRAINT tenant_settlement_policies_pk PRIMARY KEY (tenant_id, currency),
  CONSTRAINT tenant_settlement_policies_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_settlement_policies_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT tenant_settlement_policies_delay_check CHECK (delay_days BETWEEN 0 AND 90),
  CONSTRAINT tenant_settlement_policies_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT tenant_settlement_policies_version_check CHECK (version >= 0),
  CONSTRAINT tenant_settlement_policies_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS tenant_settlement_policies_set_updated_at
  ON tenant_settlement_policies;
CREATE TRIGGER tenant_settlement_policies_set_updated_at
BEFORE UPDATE ON tenant_settlement_policies
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS merchant_settlements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  balance_account_id uuid NOT NULL,
  payment_transaction_id uuid NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  eligible_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  settled_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT merchant_settlements_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT merchant_settlements_payment_unique UNIQUE (payment_transaction_id),
  CONSTRAINT merchant_settlements_account_fk FOREIGN KEY (tenant_id, balance_account_id)
    REFERENCES merchant_balance_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT merchant_settlements_transaction_fk FOREIGN KEY (payment_transaction_id)
    REFERENCES payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT merchant_settlements_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT merchant_settlements_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT merchant_settlements_status_check CHECK (status IN ('pending', 'settled')),
  CONSTRAINT merchant_settlements_lifecycle_check CHECK (
    (status = 'pending' AND settled_at IS NULL)
    OR (status = 'settled' AND settled_at IS NOT NULL AND settled_at >= eligible_at)
  ),
  CONSTRAINT merchant_settlements_eligibility_check CHECK (eligible_at >= created_at),
  CONSTRAINT merchant_settlements_version_check CHECK (version >= 0),
  CONSTRAINT merchant_settlements_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS merchant_settlements_due_idx
  ON merchant_settlements (eligible_at, created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS merchant_settlements_tenant_history_idx
  ON merchant_settlements (tenant_id, currency, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS merchant_settlements_set_updated_at ON merchant_settlements;
CREATE TRIGGER merchant_settlements_set_updated_at
BEFORE UPDATE ON merchant_settlements
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

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
    IF NEW.status IS DISTINCT FROM OLD.status
      AND NOT (OLD.status = 'pending' AND NEW.status = 'settled')
    THEN
      RAISE EXCEPTION 'Settlement status transition is not allowed' USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'settled' AND transaction_timestamp() < OLD.eligible_at THEN
      RAISE EXCEPTION 'Settlement is not eligible yet' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS merchant_settlements_enforce_snapshot ON merchant_settlements;
CREATE TRIGGER merchant_settlements_enforce_snapshot
BEFORE INSERT OR UPDATE ON merchant_settlements
FOR EACH ROW EXECUTE FUNCTION app.enforce_merchant_settlement_snapshot();

CREATE TABLE IF NOT EXISTS withdrawals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  balance_account_id uuid NOT NULL,
  withdrawal_no text NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  fee_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  payout_account_fingerprint text NOT NULL,
  applicant_staff_id uuid NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  proof_media_asset_id uuid,
  bank_reference text,
  confirmed_by uuid,
  completed_at timestamptz,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  submitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT withdrawals_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT withdrawals_no_unique UNIQUE (withdrawal_no),
  CONSTRAINT withdrawals_account_fk FOREIGN KEY (tenant_id, balance_account_id)
    REFERENCES merchant_balance_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawals_applicant_fk FOREIGN KEY (tenant_id, applicant_staff_id)
    REFERENCES tenant_staff (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawals_reviewer_fk FOREIGN KEY (reviewed_by)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawals_confirmer_fk FOREIGN KEY (confirmed_by)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawals_proof_fk FOREIGN KEY (proof_media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawals_no_check CHECK (withdrawal_no ~ '^WDR[0-9A-F]{26}$'),
  CONSTRAINT withdrawals_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT withdrawals_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
    AND fee_minor BETWEEN 0 AND amount_minor
  ),
  CONSTRAINT withdrawals_status_check CHECK (
    status IN ('submitted', 'reviewing', 'approved', 'rejected', 'cancelled', 'paying', 'paid', 'failed')
  ),
  CONSTRAINT withdrawals_fingerprint_check CHECK (
    char_length(payout_account_fingerprint) BETWEEN 4 AND 200
  ),
  CONSTRAINT withdrawals_reason_check CHECK (
    review_reason IS NULL OR char_length(btrim(review_reason)) BETWEEN 2 AND 2000
  ),
  CONSTRAINT withdrawals_bank_reference_check CHECK (
    bank_reference IS NULL OR char_length(btrim(bank_reference)) BETWEEN 3 AND 200
  ),
  CONSTRAINT withdrawals_applicant_reviewer_check CHECK (
    reviewed_by IS NULL OR reviewed_by <> applicant_staff_id
  ),
  CONSTRAINT withdrawals_lifecycle_check CHECK (
    (
      status IN ('submitted', 'reviewing')
      AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND proof_media_asset_id IS NULL AND bank_reference IS NULL
      AND confirmed_by IS NULL AND completed_at IS NULL AND cancelled_at IS NULL
    )
    OR (
      status IN ('approved', 'paying', 'failed')
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NULL
      AND proof_media_asset_id IS NULL AND bank_reference IS NULL
      AND confirmed_by IS NULL AND completed_at IS NULL AND cancelled_at IS NULL
    )
    OR (
      status = 'rejected'
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL
      AND proof_media_asset_id IS NULL AND bank_reference IS NULL
      AND confirmed_by IS NULL AND completed_at IS NULL AND cancelled_at IS NULL
    )
    OR (
      status = 'cancelled'
      AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL
      AND proof_media_asset_id IS NULL AND bank_reference IS NULL
      AND confirmed_by IS NULL AND completed_at IS NULL AND cancelled_at IS NOT NULL
    )
    OR (
      status = 'paid'
      AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_reason IS NULL
      AND proof_media_asset_id IS NOT NULL AND bank_reference IS NOT NULL
      AND confirmed_by IS NOT NULL AND completed_at IS NOT NULL AND cancelled_at IS NULL
    )
  ),
  CONSTRAINT withdrawals_version_check CHECK (version >= 0),
  CONSTRAINT withdrawals_time_check CHECK (
    submitted_at = created_at
    AND updated_at >= created_at
    AND (reviewed_at IS NULL OR reviewed_at >= submitted_at)
    AND (completed_at IS NULL OR completed_at >= reviewed_at)
    AND (cancelled_at IS NULL OR cancelled_at >= submitted_at)
  )
);

CREATE INDEX IF NOT EXISTS withdrawals_tenant_history_idx
  ON withdrawals (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS withdrawals_platform_queue_idx
  ON withdrawals (status, submitted_at, id)
  WHERE status IN ('submitted', 'reviewing', 'approved', 'paying', 'failed');

DROP TRIGGER IF EXISTS withdrawals_set_updated_at ON withdrawals;
CREATE TRIGGER withdrawals_set_updated_at
BEFORE UPDATE ON withdrawals
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS withdrawal_payout_snapshots (
  withdrawal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ciphertext text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT withdrawal_payout_snapshots_withdrawal_fk FOREIGN KEY (tenant_id, withdrawal_id)
    REFERENCES withdrawals (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT withdrawal_payout_snapshots_ciphertext_check CHECK (
    char_length(ciphertext) BETWEEN 40 AND 16384
  ),
  CONSTRAINT withdrawal_payout_snapshots_key_check CHECK (key_version > 0)
);

DROP TRIGGER IF EXISTS withdrawal_payout_snapshots_prevent_mutation
  ON withdrawal_payout_snapshots;
CREATE TRIGGER withdrawal_payout_snapshots_prevent_mutation
BEFORE UPDATE OR DELETE ON withdrawal_payout_snapshots
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS withdrawal_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  withdrawal_id uuid NOT NULL,
  action text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  reason text,
  proof_media_asset_id uuid,
  bank_reference text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT withdrawal_actions_withdrawal_fk FOREIGN KEY (tenant_id, withdrawal_id)
    REFERENCES withdrawals (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawal_actions_proof_fk FOREIGN KEY (proof_media_asset_id)
    REFERENCES media_assets (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT withdrawal_actions_action_check CHECK (
    action IN ('submit', 'cancel', 'approve', 'reject', 'confirm_transfer')
  ),
  CONSTRAINT withdrawal_actions_status_check CHECK (
    (from_status IS NULL OR from_status IN (
      'submitted', 'reviewing', 'approved', 'rejected', 'cancelled', 'paying', 'paid', 'failed'
    ))
    AND to_status IN (
      'submitted', 'reviewing', 'approved', 'rejected', 'cancelled', 'paying', 'paid', 'failed'
    )
  ),
  CONSTRAINT withdrawal_actions_actor_check CHECK (
    actor_type IN ('tenant_staff', 'platform_staff')
  ),
  CONSTRAINT withdrawal_actions_reason_check CHECK (
    reason IS NULL OR char_length(btrim(reason)) BETWEEN 2 AND 2000
  ),
  CONSTRAINT withdrawal_actions_bank_check CHECK (
    bank_reference IS NULL OR char_length(btrim(bank_reference)) BETWEEN 3 AND 200
  )
);

ALTER TABLE withdrawal_actions
  DROP CONSTRAINT IF EXISTS withdrawal_actions_action_check;
ALTER TABLE withdrawal_actions
  ADD CONSTRAINT withdrawal_actions_action_check CHECK (
    action IN (
      'submit', 'cancel', 'start_review', 'approve', 'reject',
      'start_transfer', 'transfer_failed', 'confirm_transfer'
    )
  );

CREATE INDEX IF NOT EXISTS withdrawal_actions_history_idx
  ON withdrawal_actions (tenant_id, withdrawal_id, created_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS merchant_balance_ledger_reference_leg_unique_idx
  ON merchant_balance_ledger (
    tenant_id, reference_type, reference_id, entry_type, bucket
  )
  WHERE reference_type IN (
    'payment_transaction', 'merchant_settlement', 'withdrawal'
  );

DROP TRIGGER IF EXISTS withdrawal_actions_prevent_mutation ON withdrawal_actions;
CREATE TRIGGER withdrawal_actions_prevent_mutation
BEFORE UPDATE OR DELETE ON withdrawal_actions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_withdrawal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.balance_account_id IS DISTINCT FROM OLD.balance_account_id
    OR NEW.withdrawal_no IS DISTINCT FROM OLD.withdrawal_no
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
    OR NEW.fee_minor IS DISTINCT FROM OLD.fee_minor
    OR NEW.payout_account_fingerprint IS DISTINCT FROM OLD.payout_account_fingerprint
    OR NEW.applicant_staff_id IS DISTINCT FROM OLD.applicant_staff_id
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Withdrawal snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'submitted' AND NEW.status IN ('reviewing', 'approved', 'rejected', 'cancelled') THEN
      NULL;
    ELSIF OLD.status = 'reviewing' AND NEW.status IN ('approved', 'rejected') THEN
      NULL;
    ELSIF OLD.status = 'approved' AND NEW.status IN ('paying', 'paid', 'failed') THEN
      NULL;
    ELSIF OLD.status = 'paying' AND NEW.status IN ('paid', 'failed') THEN
      NULL;
    ELSIF OLD.status = 'failed' AND NEW.status IN ('paying', 'paid') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Withdrawal status transition is not allowed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS withdrawals_enforce_transition ON withdrawals;
CREATE TRIGGER withdrawals_enforce_transition
BEFORE UPDATE ON withdrawals
FOR EACH ROW EXECUTE FUNCTION app.enforce_withdrawal_transition();

CREATE OR REPLACE FUNCTION app.validate_finance_ledger_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  settlement merchant_settlements%ROWTYPE;
  withdrawal withdrawals%ROWTYPE;
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
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS merchant_balance_ledger_00_validate_finance
  ON merchant_balance_ledger;
CREATE TRIGGER merchant_balance_ledger_00_validate_finance
BEFORE INSERT ON merchant_balance_ledger
FOR EACH ROW EXECUTE FUNCTION app.validate_finance_ledger_reference();

CREATE OR REPLACE FUNCTION app.validate_finance_balanced_entries()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  available_delta bigint;
  frozen_delta bigint;
  pending_delta bigint;
  withdrawn_delta bigint;
BEGIN
  IF TG_TABLE_NAME = 'merchant_settlements' THEN
    IF NEW.status = 'settled' THEN
      SELECT
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'pending'), 0),
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'available'), 0)
      INTO pending_delta, available_delta
      FROM merchant_balance_ledger
      WHERE tenant_id = NEW.tenant_id AND reference_type = 'merchant_settlement'
        AND reference_id = NEW.id AND entry_type = 'settlement_available';
      IF pending_delta <> -NEW.amount_minor OR available_delta <> NEW.amount_minor THEN
        RAISE EXCEPTION 'Settled record does not have balanced pending and available entries'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    SELECT
      coalesce(sum(delta_minor) FILTER (WHERE bucket = 'available' AND entry_type = 'freeze'), 0),
      coalesce(sum(delta_minor) FILTER (WHERE bucket = 'frozen' AND entry_type = 'freeze'), 0)
    INTO available_delta, frozen_delta
    FROM merchant_balance_ledger
    WHERE tenant_id = NEW.tenant_id AND reference_type = 'withdrawal'
      AND reference_id = NEW.id;
    IF available_delta <> -NEW.amount_minor OR frozen_delta <> NEW.amount_minor THEN
      RAISE EXCEPTION 'Withdrawal does not have balanced freeze entries' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('rejected', 'cancelled') THEN
      SELECT
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'available'), 0),
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'frozen'), 0)
      INTO available_delta, frozen_delta
      FROM merchant_balance_ledger
      WHERE tenant_id = NEW.tenant_id AND reference_type = 'withdrawal'
        AND reference_id = NEW.id AND entry_type = 'unfreeze';
      IF available_delta <> NEW.amount_minor OR frozen_delta <> -NEW.amount_minor THEN
        RAISE EXCEPTION 'Closed withdrawal does not have balanced unfreeze entries'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.status = 'paid' THEN
      SELECT
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'frozen'), 0),
        coalesce(sum(delta_minor) FILTER (WHERE bucket = 'withdrawn'), 0)
      INTO frozen_delta, withdrawn_delta
      FROM merchant_balance_ledger
      WHERE tenant_id = NEW.tenant_id AND reference_type = 'withdrawal'
        AND reference_id = NEW.id AND entry_type = 'withdrawal';
      IF frozen_delta <> -NEW.amount_minor OR withdrawn_delta <> NEW.amount_minor THEN
        RAISE EXCEPTION 'Paid withdrawal does not have balanced payout entries'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS merchant_settlements_require_balanced_ledger
  ON merchant_settlements;
CREATE CONSTRAINT TRIGGER merchant_settlements_require_balanced_ledger
AFTER INSERT OR UPDATE ON merchant_settlements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.validate_finance_balanced_entries();

DROP TRIGGER IF EXISTS withdrawals_require_balanced_ledger ON withdrawals;
CREATE CONSTRAINT TRIGGER withdrawals_require_balanced_ledger
AFTER INSERT OR UPDATE ON withdrawals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.validate_finance_balanced_entries();

CREATE OR REPLACE FUNCTION app.enforce_withdrawal_action()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target withdrawals%ROWTYPE;
BEGIN
  SELECT * INTO target FROM withdrawals
  WHERE id = NEW.withdrawal_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR target.status <> NEW.to_status THEN
    RAISE EXCEPTION 'Withdrawal action does not match the current withdrawal state'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.action = 'submit' AND NOT (
    NEW.from_status IS NULL AND NEW.to_status = 'submitted'
    AND NEW.actor_type = 'tenant_staff' AND NEW.actor_id = target.applicant_staff_id
  ) THEN
    RAISE EXCEPTION 'Withdrawal submit action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action = 'cancel' AND NOT (
    NEW.from_status = 'submitted' AND NEW.to_status = 'cancelled'
    AND NEW.actor_type = 'tenant_staff' AND NEW.actor_id = target.applicant_staff_id
  ) THEN
    RAISE EXCEPTION 'Withdrawal cancel action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action = 'start_review' AND NOT (
    NEW.from_status = 'submitted' AND NEW.to_status = 'reviewing'
    AND NEW.actor_type = 'platform_staff'
    AND NEW.reason IS NULL AND NEW.proof_media_asset_id IS NULL
    AND NEW.bank_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'Withdrawal review-start action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action IN ('approve', 'reject') AND NOT (
    NEW.from_status IN ('submitted', 'reviewing')
    AND NEW.to_status = CASE WHEN NEW.action = 'approve' THEN 'approved' ELSE 'rejected' END
    AND NEW.actor_type = 'platform_staff'
    AND NEW.actor_id = target.reviewed_by
    AND NEW.actor_id <> target.applicant_staff_id
    AND NEW.reason IS NOT DISTINCT FROM target.review_reason
    AND NEW.proof_media_asset_id IS NULL
    AND NEW.bank_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'Withdrawal review action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action = 'confirm_transfer' AND NOT (
    NEW.from_status IN ('approved', 'paying', 'failed') AND NEW.to_status = 'paid'
    AND NEW.actor_type = 'platform_staff'
    AND NEW.actor_id = target.confirmed_by
    AND NEW.proof_media_asset_id = target.proof_media_asset_id
    AND NEW.bank_reference = target.bank_reference
    AND NEW.reason IS NULL
  ) THEN
    RAISE EXCEPTION 'Withdrawal transfer action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action = 'start_transfer' AND NOT (
    NEW.from_status IN ('approved', 'failed') AND NEW.to_status = 'paying'
    AND NEW.actor_type = 'platform_staff'
    AND NEW.reason IS NULL AND NEW.proof_media_asset_id IS NULL
    AND NEW.bank_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'Withdrawal transfer-start action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action = 'transfer_failed' AND NOT (
    NEW.from_status IN ('approved', 'paying') AND NEW.to_status = 'failed'
    AND NEW.actor_type = 'platform_staff' AND NEW.reason IS NOT NULL
    AND NEW.proof_media_asset_id IS NULL AND NEW.bank_reference IS NULL
  ) THEN
    RAISE EXCEPTION 'Withdrawal transfer-failed action is invalid' USING ERRCODE = '23514';
  ELSIF NEW.action NOT IN (
    'submit', 'cancel', 'start_review', 'approve', 'reject',
    'start_transfer', 'transfer_failed', 'confirm_transfer'
  ) THEN
    RAISE EXCEPTION 'Withdrawal action is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS withdrawal_actions_enforce ON withdrawal_actions;
CREATE TRIGGER withdrawal_actions_enforce
BEFORE INSERT ON withdrawal_actions
FOR EACH ROW EXECUTE FUNCTION app.enforce_withdrawal_action();

CREATE OR REPLACE FUNCTION app.require_withdrawal_action()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  required_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    required_action := 'submit';
  ELSIF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  ELSIF OLD.status = 'submitted' AND NEW.status = 'reviewing' THEN
    required_action := 'start_review';
  ELSIF OLD.status IN ('submitted', 'reviewing') AND NEW.status = 'approved' THEN
    required_action := 'approve';
  ELSIF OLD.status IN ('submitted', 'reviewing') AND NEW.status = 'rejected' THEN
    required_action := 'reject';
  ELSIF OLD.status = 'submitted' AND NEW.status = 'cancelled' THEN
    required_action := 'cancel';
  ELSIF OLD.status IN ('approved', 'failed') AND NEW.status = 'paying' THEN
    required_action := 'start_transfer';
  ELSIF OLD.status IN ('approved', 'paying') AND NEW.status = 'failed' THEN
    required_action := 'transfer_failed';
  ELSIF OLD.status IN ('approved', 'paying', 'failed') AND NEW.status = 'paid' THEN
    required_action := 'confirm_transfer';
  ELSE
    RAISE EXCEPTION 'Withdrawal status change has no corresponding action type'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM withdrawal_actions AS action
    WHERE action.tenant_id = NEW.tenant_id
      AND action.withdrawal_id = NEW.id
      AND action.action = required_action
      AND action.from_status IS NOT DISTINCT FROM CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END
      AND action.to_status = NEW.status
      AND (
        (required_action IN ('submit', 'cancel')
          AND action.actor_type = 'tenant_staff'
          AND action.actor_id = NEW.applicant_staff_id)
        OR (required_action IN ('approve', 'reject')
          AND action.actor_type = 'platform_staff'
          AND action.actor_id = NEW.reviewed_by)
        OR (required_action = 'confirm_transfer'
          AND action.actor_type = 'platform_staff'
          AND action.actor_id = NEW.confirmed_by
          AND action.proof_media_asset_id = NEW.proof_media_asset_id
          AND action.bank_reference = NEW.bank_reference)
        OR (required_action IN ('start_review', 'start_transfer', 'transfer_failed')
          AND action.actor_type = 'platform_staff')
      )
  ) THEN
    RAISE EXCEPTION 'Withdrawal state change requires a matching immutable action'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS withdrawals_require_action ON withdrawals;
CREATE CONSTRAINT TRIGGER withdrawals_require_action
AFTER INSERT OR UPDATE ON withdrawals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.require_withdrawal_action();

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

INSERT INTO merchant_settlements (
  id, tenant_id, balance_account_id, payment_transaction_id,
  currency, amount_minor, eligible_at, created_at, updated_at
)
SELECT
  ledger.id, ledger.tenant_id, ledger.balance_account_id,
  payment_transaction.id, ledger.currency, ledger.delta_minor,
  ledger.created_at + coalesce(policy.delay_days, 7) * interval '1 day',
  ledger.created_at, ledger.created_at
FROM merchant_balance_ledger AS ledger
INNER JOIN payment_transactions AS payment_transaction
  ON payment_transaction.id = ledger.reference_id
LEFT JOIN tenant_settlement_policies AS policy
  ON policy.tenant_id = ledger.tenant_id AND policy.currency = ledger.currency
  AND policy.status = 'active'
WHERE ledger.reference_type = 'payment_transaction'
  AND ledger.entry_type = 'payment_pending'
  AND ledger.bucket = 'pending'
  AND ledger.delta_minor > 0
ON CONFLICT (payment_transaction_id) DO NOTHING;

ALTER TABLE tenant_settlement_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settlement_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_settlement_policies_tenant_select ON tenant_settlement_policies;
CREATE POLICY tenant_settlement_policies_tenant_select ON tenant_settlement_policies FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_settlement_policies_platform_access ON tenant_settlement_policies;
CREATE POLICY tenant_settlement_policies_platform_access ON tenant_settlement_policies FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE merchant_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS merchant_settlements_tenant_select ON merchant_settlements;
CREATE POLICY merchant_settlements_tenant_select ON merchant_settlements FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS merchant_settlements_platform_access ON merchant_settlements;
CREATE POLICY merchant_settlements_platform_access ON merchant_settlements FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS withdrawals_tenant_access ON withdrawals;
CREATE POLICY withdrawals_tenant_access ON withdrawals FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS withdrawals_platform_access ON withdrawals;
CREATE POLICY withdrawals_platform_access ON withdrawals FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE withdrawal_payout_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_payout_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS withdrawal_payout_snapshots_tenant_insert
  ON withdrawal_payout_snapshots;
DROP POLICY IF EXISTS withdrawal_payout_snapshots_platform_access
  ON withdrawal_payout_snapshots;
CREATE POLICY withdrawal_payout_snapshots_platform_access
  ON withdrawal_payout_snapshots FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE withdrawal_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawal_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS withdrawal_actions_tenant_access ON withdrawal_actions;
CREATE POLICY withdrawal_actions_tenant_access ON withdrawal_actions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS withdrawal_actions_platform_access ON withdrawal_actions;
CREATE POLICY withdrawal_actions_platform_access ON withdrawal_actions FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

DROP POLICY IF EXISTS merchant_balance_accounts_tenant_access
  ON merchant_balance_accounts;
CREATE POLICY merchant_balance_accounts_tenant_access
  ON merchant_balance_accounts FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS merchant_balance_ledger_tenant_access
  ON merchant_balance_ledger;
CREATE POLICY merchant_balance_ledger_tenant_access
  ON merchant_balance_ledger FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_attempts_tenant_access ON payment_attempts;
CREATE POLICY payment_attempts_tenant_access ON payment_attempts FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_transactions_tenant_access ON payment_transactions;
CREATE POLICY payment_transactions_tenant_access ON payment_transactions FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_webhook_inbox_tenant_access ON payment_webhook_inbox;
CREATE POLICY payment_webhook_inbox_tenant_access ON payment_webhook_inbox FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_webhook_outbox_tenant_access ON payment_webhook_outbox;
CREATE POLICY payment_webhook_outbox_tenant_access ON payment_webhook_outbox FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS payment_refunds_tenant_access ON payment_refunds;
CREATE POLICY payment_refunds_tenant_access ON payment_refunds FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS point_accounts_tenant_access ON point_accounts;
CREATE POLICY point_accounts_tenant_access ON point_accounts FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS point_ledger_tenant_access ON point_ledger;
CREATE POLICY point_ledger_tenant_access ON point_ledger FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS entitlements_tenant_access ON entitlements;
CREATE POLICY entitlements_tenant_access ON entitlements FOR SELECT
  USING (tenant_id = app.current_tenant_id());

DROP POLICY IF EXISTS orders_tenant_access ON orders;
DROP POLICY IF EXISTS orders_tenant_select ON orders;
CREATE POLICY orders_tenant_select ON orders FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS orders_tenant_insert ON orders;
CREATE POLICY orders_tenant_insert ON orders FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND status = 'pending_payment'
    AND paid_at IS NULL
  );
DROP POLICY IF EXISTS orders_tenant_update_pending ON orders;
CREATE POLICY orders_tenant_update_pending ON orders FOR UPDATE
  USING (
    tenant_id = app.current_tenant_id()
    AND status = 'pending_payment'
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND status IN ('pending_payment', 'expired', 'cancelled')
    AND paid_at IS NULL
  );

DROP POLICY IF EXISTS order_items_tenant_access ON order_items;
DROP POLICY IF EXISTS order_items_tenant_select ON order_items;
CREATE POLICY order_items_tenant_select ON order_items FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS order_items_tenant_insert ON order_items;
CREATE POLICY order_items_tenant_insert ON order_items FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = order_items.order_id
        AND orders.tenant_id = order_items.tenant_id
        AND orders.status = 'pending_payment'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_payment_topup_unique_idx
  ON point_ledger (tenant_id, account_id, reference_type, reference_id, entry_type)
  WHERE reference_type = 'payment_transaction' AND entry_type = 'topup';

REVOKE ALL ON FUNCTION app.enforce_merchant_settlement_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_withdrawal_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_finance_ledger_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_finance_balanced_entries() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_withdrawal_action() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_withdrawal_action() FROM PUBLIC;

COMMIT;
