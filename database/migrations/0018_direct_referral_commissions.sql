BEGIN;

CREATE OR REPLACE FUNCTION app.valid_referral_order_types(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT
    value IS NOT NULL
    AND cardinality(value) BETWEEN 0 AND 4
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS item
      WHERE item IS NULL
        OR item NOT IN ('membership', 'drama', 'episode', 'points_topup')
    )
    AND cardinality(value) = (
      SELECT count(DISTINCT item)::integer FROM unnest(value) AS item
    )
$function$;

CREATE TABLE IF NOT EXISTS tenant_referral_configs (
  tenant_id uuid PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  commission_bps integer NOT NULL DEFAULT 0,
  settlement_days integer NOT NULL DEFAULT 7,
  applicable_order_types text[] NOT NULL DEFAULT '{}'::text[],
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid,
  CONSTRAINT tenant_referral_configs_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_referral_configs_bps_check CHECK (
    commission_bps BETWEEN 0 AND 10000
    AND (NOT enabled OR commission_bps > 0)
  ),
  CONSTRAINT tenant_referral_configs_settlement_check CHECK (
    settlement_days BETWEEN 0 AND 90
  ),
  CONSTRAINT tenant_referral_configs_types_check CHECK (
    app.valid_referral_order_types(applicable_order_types)
    AND (NOT enabled OR cardinality(applicable_order_types) > 0)
  ),
  CONSTRAINT tenant_referral_configs_version_check CHECK (version >= 0),
  CONSTRAINT tenant_referral_configs_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS tenant_referral_configs_set_updated_at
  ON tenant_referral_configs;
CREATE TRIGGER tenant_referral_configs_set_updated_at
BEFORE UPDATE ON tenant_referral_configs
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_referral_configs_prevent_delete
  ON tenant_referral_configs;
CREATE TRIGGER tenant_referral_configs_prevent_delete
BEFORE DELETE ON tenant_referral_configs
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS customer_referral_codes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_referral_codes_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_referral_codes_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_referral_codes_account_unique UNIQUE (tenant_id, account_id),
  CONSTRAINT customer_referral_codes_code_unique UNIQUE (code),
  CONSTRAINT customer_referral_codes_code_check CHECK (code ~ '^[A-Z2-9]{10}$')
);

DROP TRIGGER IF EXISTS customer_referral_codes_prevent_mutation
  ON customer_referral_codes;
CREATE TRIGGER customer_referral_codes_prevent_mutation
BEFORE UPDATE OR DELETE ON customer_referral_codes
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS customer_referrals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  invitee_account_id uuid NOT NULL,
  inviter_account_id uuid NOT NULL,
  referral_code_id uuid NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_referrals_invitee_fk FOREIGN KEY (tenant_id, invitee_account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_referrals_inviter_fk FOREIGN KEY (tenant_id, inviter_account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_referrals_code_fk FOREIGN KEY (tenant_id, referral_code_id)
    REFERENCES customer_referral_codes (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_referrals_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_referrals_invitee_unique UNIQUE (tenant_id, invitee_account_id),
  CONSTRAINT customer_referrals_self_check CHECK (invitee_account_id <> inviter_account_id)
);

CREATE INDEX IF NOT EXISTS customer_referrals_inviter_idx
  ON customer_referrals (tenant_id, inviter_account_id, bound_at DESC, id DESC);

CREATE OR REPLACE FUNCTION app.enforce_customer_referral_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM customer_referral_codes AS referral_code
    WHERE referral_code.id = NEW.referral_code_id
      AND referral_code.tenant_id = NEW.tenant_id
      AND referral_code.account_id = NEW.inviter_account_id
  ) THEN
    RAISE EXCEPTION 'Referral code does not belong to the selected inviter'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM orders AS commerce_order
    WHERE commerce_order.tenant_id = NEW.tenant_id
      AND commerce_order.account_id = NEW.invitee_account_id
      AND commerce_order.paid_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Referral binding is closed after the first paid order'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE inviter_chain(account_id) AS (
      SELECT NEW.inviter_account_id
      UNION
      SELECT relationship.inviter_account_id
      FROM customer_referrals AS relationship
      INNER JOIN inviter_chain
        ON inviter_chain.account_id = relationship.invitee_account_id
      WHERE relationship.tenant_id = NEW.tenant_id
    )
    SELECT 1 FROM inviter_chain WHERE account_id = NEW.invitee_account_id
  ) THEN
    RAISE EXCEPTION 'Referral binding would create a cycle'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_referrals_enforce_binding ON customer_referrals;
CREATE TRIGGER customer_referrals_enforce_binding
BEFORE INSERT ON customer_referrals
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_referral_binding();

DROP TRIGGER IF EXISTS customer_referrals_prevent_mutation ON customer_referrals;
CREATE TRIGGER customer_referrals_prevent_mutation
BEFORE UPDATE OR DELETE ON customer_referrals
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS referral_commission_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  pending_minor bigint NOT NULL DEFAULT 0,
  available_minor bigint NOT NULL DEFAULT 0,
  withdrawn_minor bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT referral_commission_accounts_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commission_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT referral_commission_accounts_scope_unique UNIQUE (tenant_id, account_id, currency),
  CONSTRAINT referral_commission_accounts_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT referral_commission_accounts_amounts_check CHECK (
    pending_minor BETWEEN 0 AND 9000000000000000
    AND available_minor BETWEEN 0 AND 9000000000000000
    AND withdrawn_minor BETWEEN 0 AND 9000000000000000
  ),
  CONSTRAINT referral_commission_accounts_version_check CHECK (version >= 0),
  CONSTRAINT referral_commission_accounts_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS referral_commission_accounts_customer_idx
  ON referral_commission_accounts (tenant_id, account_id, currency);

DROP TRIGGER IF EXISTS referral_commission_accounts_set_updated_at
  ON referral_commission_accounts;
CREATE TRIGGER referral_commission_accounts_set_updated_at
BEFORE UPDATE ON referral_commission_accounts
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.prevent_direct_referral_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pending_minor <> 0 OR NEW.available_minor <> 0 OR NEW.withdrawn_minor <> 0 THEN
      RAISE EXCEPTION 'Referral commission accounts must start with zero balances'
        USING ERRCODE = '42501';
    END IF;
  ELSIF (
    NEW.pending_minor IS DISTINCT FROM OLD.pending_minor
    OR NEW.available_minor IS DISTINCT FROM OLD.available_minor
    OR NEW.withdrawn_minor IS DISTINCT FROM OLD.withdrawn_minor
  ) AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Referral balances may only change through their immutable ledger'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS referral_commission_accounts_enforce_initial_balance
  ON referral_commission_accounts;
CREATE TRIGGER referral_commission_accounts_enforce_initial_balance
BEFORE INSERT ON referral_commission_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_referral_balance_update();

DROP TRIGGER IF EXISTS referral_commission_accounts_prevent_direct_balance_update
  ON referral_commission_accounts;
CREATE TRIGGER referral_commission_accounts_prevent_direct_balance_update
BEFORE UPDATE OF pending_minor, available_minor, withdrawn_minor
ON referral_commission_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_referral_balance_update();

CREATE OR REPLACE FUNCTION app.enforce_referral_commission_account_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Referral commission accounts are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Referral commission account identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS referral_commission_accounts_enforce_identity
  ON referral_commission_accounts;
CREATE TRIGGER referral_commission_accounts_enforce_identity
BEFORE UPDATE OR DELETE ON referral_commission_accounts
FOR EACH ROW EXECUTE FUNCTION app.enforce_referral_commission_account_identity();

CREATE TABLE IF NOT EXISTS referral_commissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  invitee_account_id uuid NOT NULL,
  inviter_account_id uuid NOT NULL,
  commission_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_transaction_id uuid NOT NULL,
  config_version_snapshot integer NOT NULL,
  commission_bps_snapshot integer NOT NULL,
  settlement_days_snapshot integer NOT NULL,
  order_type_snapshot text NOT NULL,
  currency text NOT NULL,
  order_total_minor_snapshot bigint NOT NULL,
  commission_minor bigint NOT NULL,
  eligible_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  available_at timestamptz,
  reversal_transaction_id uuid,
  reversed_from_status text,
  reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT referral_commissions_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT referral_commissions_referral_fk FOREIGN KEY (tenant_id, referral_id)
    REFERENCES customer_referrals (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_invitee_fk FOREIGN KEY (tenant_id, invitee_account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_inviter_fk FOREIGN KEY (tenant_id, inviter_account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_account_fk FOREIGN KEY (tenant_id, commission_account_id)
    REFERENCES referral_commission_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_payment_fk FOREIGN KEY (payment_transaction_id)
    REFERENCES payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_reversal_fk FOREIGN KEY (reversal_transaction_id)
    REFERENCES payment_transactions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commissions_order_unique UNIQUE (order_id),
  CONSTRAINT referral_commissions_payment_unique UNIQUE (payment_transaction_id),
  CONSTRAINT referral_commissions_config_version_check CHECK (config_version_snapshot >= 0),
  CONSTRAINT referral_commissions_bps_check CHECK (
    commission_bps_snapshot BETWEEN 1 AND 10000
  ),
  CONSTRAINT referral_commissions_settlement_check CHECK (
    settlement_days_snapshot BETWEEN 0 AND 90
  ),
  CONSTRAINT referral_commissions_order_type_check CHECK (
    order_type_snapshot IN ('membership', 'drama', 'episode', 'points_topup')
  ),
  CONSTRAINT referral_commissions_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT referral_commissions_amount_check CHECK (
    order_total_minor_snapshot BETWEEN 1 AND 9000000000000000
    AND commission_minor BETWEEN 1 AND order_total_minor_snapshot
  ),
  CONSTRAINT referral_commissions_status_check CHECK (
    status IN ('pending', 'available', 'reversed')
  ),
  CONSTRAINT referral_commissions_lifecycle_check CHECK (
    (
      status = 'pending'
      AND available_at IS NULL
      AND reversal_transaction_id IS NULL
      AND reversed_from_status IS NULL
      AND reversed_at IS NULL
    )
    OR (
      status = 'available'
      AND available_at IS NOT NULL
      AND available_at >= eligible_at
      AND reversal_transaction_id IS NULL
      AND reversed_from_status IS NULL
      AND reversed_at IS NULL
    )
    OR (
      status = 'reversed'
      AND reversal_transaction_id IS NOT NULL
      AND reversed_from_status IN ('pending', 'available')
      AND reversed_at IS NOT NULL
      AND reversed_at >= created_at
      AND (
        (reversed_from_status = 'pending' AND available_at IS NULL)
        OR (reversed_from_status = 'available' AND available_at IS NOT NULL)
      )
    )
  ),
  CONSTRAINT referral_commissions_eligibility_check CHECK (
    eligible_at = created_at + settlement_days_snapshot * interval '1 day'
  ),
  CONSTRAINT referral_commissions_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS referral_commissions_due_idx
  ON referral_commissions (eligible_at, created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS referral_commissions_inviter_history_idx
  ON referral_commissions (
    tenant_id, inviter_account_id, currency, created_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS referral_commissions_tenant_history_idx
  ON referral_commissions (tenant_id, status, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS referral_commissions_set_updated_at ON referral_commissions;
CREATE TRIGGER referral_commissions_set_updated_at
BEFORE UPDATE ON referral_commissions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_referral_commission_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  expected_commission bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT floor(
      commerce_order.total_minor::numeric * NEW.commission_bps_snapshot::numeric / 10000
    )::bigint
    INTO expected_commission
    FROM orders AS commerce_order
    INNER JOIN payment_transactions AS payment_transaction
      ON payment_transaction.id = NEW.payment_transaction_id
      AND payment_transaction.tenant_id = commerce_order.tenant_id
      AND payment_transaction.order_id = commerce_order.id
    INNER JOIN customer_referrals AS relationship
      ON relationship.id = NEW.referral_id
      AND relationship.tenant_id = commerce_order.tenant_id
      AND relationship.invitee_account_id = commerce_order.account_id
    INNER JOIN tenant_referral_configs AS config
      ON config.tenant_id = commerce_order.tenant_id
    INNER JOIN referral_commission_accounts AS commission_account
      ON commission_account.id = NEW.commission_account_id
      AND commission_account.tenant_id = commerce_order.tenant_id
      AND commission_account.account_id = relationship.inviter_account_id
      AND commission_account.currency = commerce_order.currency
    WHERE commerce_order.id = NEW.order_id
      AND commerce_order.tenant_id = NEW.tenant_id
      AND commerce_order.status = 'paid'
      AND commerce_order.paid_at IS NOT NULL
      AND commerce_order.account_id = NEW.invitee_account_id
      AND commerce_order.order_type = NEW.order_type_snapshot
      AND commerce_order.currency = NEW.currency
      AND commerce_order.total_minor = NEW.order_total_minor_snapshot
      AND payment_transaction.transaction_type = 'charge'
      AND payment_transaction.status = 'succeeded'
      AND payment_transaction.currency = commerce_order.currency
      AND payment_transaction.amount_minor = commerce_order.total_minor
      AND relationship.inviter_account_id = NEW.inviter_account_id
      AND relationship.bound_at <= commerce_order.paid_at
      AND config.enabled
      AND config.version = NEW.config_version_snapshot
      AND config.commission_bps = NEW.commission_bps_snapshot
      AND config.settlement_days = NEW.settlement_days_snapshot
      AND commerce_order.order_type = ANY(config.applicable_order_types);

    IF expected_commission IS NULL OR expected_commission <> NEW.commission_minor THEN
      RAISE EXCEPTION 'Referral commission does not match its paid order snapshot'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.referral_id IS DISTINCT FROM OLD.referral_id
      OR NEW.invitee_account_id IS DISTINCT FROM OLD.invitee_account_id
      OR NEW.inviter_account_id IS DISTINCT FROM OLD.inviter_account_id
      OR NEW.commission_account_id IS DISTINCT FROM OLD.commission_account_id
      OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.payment_transaction_id IS DISTINCT FROM OLD.payment_transaction_id
      OR NEW.config_version_snapshot IS DISTINCT FROM OLD.config_version_snapshot
      OR NEW.commission_bps_snapshot IS DISTINCT FROM OLD.commission_bps_snapshot
      OR NEW.settlement_days_snapshot IS DISTINCT FROM OLD.settlement_days_snapshot
      OR NEW.order_type_snapshot IS DISTINCT FROM OLD.order_type_snapshot
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.order_total_minor_snapshot IS DISTINCT FROM OLD.order_total_minor_snapshot
      OR NEW.commission_minor IS DISTINCT FROM OLD.commission_minor
      OR NEW.eligible_at IS DISTINCT FROM OLD.eligible_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Referral commission commercial snapshot is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'pending' AND NEW.status = 'available' THEN
        IF transaction_timestamp() < OLD.eligible_at THEN
          RAISE EXCEPTION 'Referral commission is not eligible for settlement'
            USING ERRCODE = '23514';
        END IF;
      ELSIF OLD.status IN ('pending', 'available') AND NEW.status = 'reversed' THEN
        IF NEW.reversed_from_status IS DISTINCT FROM OLD.status OR NOT EXISTS (
          SELECT 1 FROM payment_transactions AS reversal
          WHERE reversal.id = NEW.reversal_transaction_id
            AND reversal.tenant_id = NEW.tenant_id
            AND reversal.order_id = NEW.order_id
            AND reversal.transaction_type = 'refund'
            AND reversal.status = 'succeeded'
            AND reversal.currency = NEW.currency
            AND reversal.amount_minor = NEW.order_total_minor_snapshot
        ) THEN
          RAISE EXCEPTION 'Referral commission reversal lacks a matching refund'
            USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'Referral commission status transition is not allowed'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS referral_commissions_enforce_snapshot ON referral_commissions;
CREATE TRIGGER referral_commissions_enforce_snapshot
BEFORE INSERT OR UPDATE ON referral_commissions
FOR EACH ROW EXECUTE FUNCTION app.enforce_referral_commission_snapshot();

CREATE TABLE IF NOT EXISTS referral_commission_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  commission_account_id uuid NOT NULL,
  commission_id uuid NOT NULL,
  bucket text NOT NULL,
  entry_type text NOT NULL,
  currency text NOT NULL,
  delta_minor bigint NOT NULL,
  balance_after_minor bigint NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT referral_commission_ledger_account_fk
    FOREIGN KEY (tenant_id, commission_account_id)
    REFERENCES referral_commission_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commission_ledger_commission_fk
    FOREIGN KEY (tenant_id, commission_id)
    REFERENCES referral_commissions (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT referral_commission_ledger_idempotency_unique
    UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT referral_commission_ledger_fact_unique
    UNIQUE (tenant_id, commission_id, entry_type),
  CONSTRAINT referral_commission_ledger_bucket_check CHECK (
    bucket IN ('pending', 'available', 'withdrawn')
  ),
  CONSTRAINT referral_commission_ledger_type_check CHECK (
    entry_type IN (
      'commission_pending',
      'settlement_pending_debit',
      'settlement_available_credit',
      'reversal_pending_debit',
      'reversal_available_debit'
    )
  ),
  CONSTRAINT referral_commission_ledger_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT referral_commission_ledger_delta_check CHECK (
    delta_minor <> 0
    AND delta_minor BETWEEN -9000000000000000 AND 9000000000000000
  ),
  CONSTRAINT referral_commission_ledger_balance_check CHECK (
    balance_after_minor BETWEEN 0 AND 9000000000000000
  ),
  CONSTRAINT referral_commission_ledger_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT referral_commission_ledger_shape_check CHECK (
    (entry_type = 'commission_pending' AND bucket = 'pending' AND delta_minor > 0)
    OR (entry_type = 'settlement_pending_debit' AND bucket = 'pending' AND delta_minor < 0)
    OR (entry_type = 'settlement_available_credit' AND bucket = 'available' AND delta_minor > 0)
    OR (entry_type = 'reversal_pending_debit' AND bucket = 'pending' AND delta_minor < 0)
    OR (entry_type = 'reversal_available_debit' AND bucket = 'available' AND delta_minor < 0)
  )
);

CREATE INDEX IF NOT EXISTS referral_commission_ledger_customer_history_idx
  ON referral_commission_ledger (
    tenant_id, commission_account_id, currency, created_at DESC, id DESC
  );

CREATE OR REPLACE FUNCTION app.apply_referral_commission_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  commission_row referral_commissions%ROWTYPE;
  account_row referral_commission_accounts%ROWTYPE;
  next_balance bigint;
BEGIN
  SELECT * INTO commission_row
  FROM referral_commissions
  WHERE id = NEW.commission_id AND tenant_id = NEW.tenant_id;

  IF NOT FOUND
    OR commission_row.commission_account_id <> NEW.commission_account_id
    OR commission_row.currency <> NEW.currency
    OR abs(NEW.delta_minor) <> commission_row.commission_minor
    OR (
      NEW.entry_type = 'commission_pending'
      AND commission_row.status <> 'pending'
    )
    OR (
      NEW.entry_type IN ('settlement_pending_debit', 'settlement_available_credit')
      AND commission_row.status <> 'available'
    )
    OR (
      NEW.entry_type = 'reversal_pending_debit'
      AND NOT (
        commission_row.status = 'reversed'
        AND commission_row.reversed_from_status = 'pending'
      )
    )
    OR (
      NEW.entry_type = 'reversal_available_debit'
      AND NOT (
        commission_row.status = 'reversed'
        AND commission_row.reversed_from_status = 'available'
      )
    )
  THEN
    RAISE EXCEPTION 'Referral ledger entry does not match its commission fact'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO account_row
  FROM referral_commission_accounts
  WHERE id = NEW.commission_account_id
    AND tenant_id = NEW.tenant_id
    AND currency = NEW.currency
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referral commission account does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.bucket = 'pending' THEN
    next_balance := account_row.pending_minor + NEW.delta_minor;
  ELSIF NEW.bucket = 'available' THEN
    next_balance := account_row.available_minor + NEW.delta_minor;
  ELSE
    next_balance := account_row.withdrawn_minor + NEW.delta_minor;
  END IF;
  IF next_balance < 0 OR next_balance > 9000000000000000 THEN
    RAISE EXCEPTION 'Referral balance would be outside its allowed range'
      USING ERRCODE = '23514';
  END IF;

  NEW.balance_after_minor := next_balance;
  UPDATE referral_commission_accounts
  SET
    pending_minor = CASE WHEN NEW.bucket = 'pending' THEN next_balance ELSE pending_minor END,
    available_minor = CASE WHEN NEW.bucket = 'available' THEN next_balance ELSE available_minor END,
    withdrawn_minor = CASE WHEN NEW.bucket = 'withdrawn' THEN next_balance ELSE withdrawn_minor END,
    version = version + 1
  WHERE id = account_row.id;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS referral_commission_ledger_apply_balance
  ON referral_commission_ledger;
CREATE TRIGGER referral_commission_ledger_apply_balance
BEFORE INSERT ON referral_commission_ledger
FOR EACH ROW EXECUTE FUNCTION app.apply_referral_commission_ledger();

DROP TRIGGER IF EXISTS referral_commission_ledger_prevent_mutation
  ON referral_commission_ledger;
CREATE TRIGGER referral_commission_ledger_prevent_mutation
BEFORE UPDATE OR DELETE ON referral_commission_ledger
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.require_referral_commission_ledger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM referral_commission_ledger AS ledger
    WHERE ledger.tenant_id = NEW.tenant_id
      AND ledger.commission_id = NEW.id
      AND ledger.commission_account_id = NEW.commission_account_id
      AND ledger.entry_type = 'commission_pending'
      AND ledger.bucket = 'pending'
      AND ledger.currency = NEW.currency
      AND ledger.delta_minor = NEW.commission_minor
  ) THEN
    RAISE EXCEPTION 'Referral commission is missing its pending ledger credit'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'available' AND NOT (
    EXISTS (
      SELECT 1 FROM referral_commission_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.commission_id = NEW.id
        AND ledger.entry_type = 'settlement_pending_debit'
        AND ledger.delta_minor = -NEW.commission_minor
    )
    AND EXISTS (
      SELECT 1 FROM referral_commission_ledger AS ledger
      WHERE ledger.tenant_id = NEW.tenant_id
        AND ledger.commission_id = NEW.id
        AND ledger.entry_type = 'settlement_available_credit'
        AND ledger.delta_minor = NEW.commission_minor
    )
  ) THEN
    RAISE EXCEPTION 'Available referral commission is missing balanced settlement entries'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'reversed' AND NOT EXISTS (
    SELECT 1 FROM referral_commission_ledger AS ledger
    WHERE ledger.tenant_id = NEW.tenant_id
      AND ledger.commission_id = NEW.id
      AND ledger.entry_type = CASE NEW.reversed_from_status
        WHEN 'pending' THEN 'reversal_pending_debit'
        ELSE 'reversal_available_debit'
      END
      AND ledger.delta_minor = -NEW.commission_minor
  ) THEN
    RAISE EXCEPTION 'Reversed referral commission is missing its reversal ledger entry'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS referral_commissions_require_ledger ON referral_commissions;
CREATE CONSTRAINT TRIGGER referral_commissions_require_ledger
AFTER INSERT OR UPDATE OF status ON referral_commissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.require_referral_commission_ledger();

ALTER TABLE tenant_referral_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_referral_configs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_referral_configs_tenant_access ON tenant_referral_configs;
CREATE POLICY tenant_referral_configs_tenant_access ON tenant_referral_configs FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_referral_configs_platform_access ON tenant_referral_configs;
CREATE POLICY tenant_referral_configs_platform_access ON tenant_referral_configs FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_referral_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_referral_codes_tenant_select ON customer_referral_codes;
CREATE POLICY customer_referral_codes_tenant_select ON customer_referral_codes FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_referral_codes_platform_access ON customer_referral_codes;
CREATE POLICY customer_referral_codes_platform_access ON customer_referral_codes FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_referrals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_referrals_tenant_select ON customer_referrals;
CREATE POLICY customer_referrals_tenant_select ON customer_referrals FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_referrals_platform_access ON customer_referrals;
CREATE POLICY customer_referrals_platform_access ON customer_referrals FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE referral_commission_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_commission_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_commission_accounts_tenant_select
  ON referral_commission_accounts;
CREATE POLICY referral_commission_accounts_tenant_select
  ON referral_commission_accounts FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS referral_commission_accounts_platform_access
  ON referral_commission_accounts;
CREATE POLICY referral_commission_accounts_platform_access
  ON referral_commission_accounts FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE referral_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_commissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_commissions_tenant_select ON referral_commissions;
CREATE POLICY referral_commissions_tenant_select ON referral_commissions FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS referral_commissions_platform_access ON referral_commissions;
CREATE POLICY referral_commissions_platform_access ON referral_commissions FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE referral_commission_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_commission_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS referral_commission_ledger_tenant_select
  ON referral_commission_ledger;
CREATE POLICY referral_commission_ledger_tenant_select
  ON referral_commission_ledger FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS referral_commission_ledger_platform_access
  ON referral_commission_ledger;
CREATE POLICY referral_commission_ledger_platform_access
  ON referral_commission_ledger FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.valid_referral_order_types(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.valid_referral_order_types(text[]) TO PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_customer_referral_binding() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_direct_referral_balance_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_referral_commission_account_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_referral_commission_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_referral_commission_ledger() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.require_referral_commission_ledger() FROM PUBLIC;

COMMIT;
