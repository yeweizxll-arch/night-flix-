CREATE TABLE IF NOT EXISTS native_purchase_accounts (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  binding uuid NOT NULL UNIQUE,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS native_store_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  store text NOT NULL CHECK (store IN ('apple', 'google')),
  application_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  external_id text NOT NULL,
  original_id text NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  store_product_id text NOT NULL,
  product_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('points_topup', 'membership')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint NOT NULL CHECK (gross_minor BETWEEN 0 AND 9000000000000000),
  net_minor bigint CHECK (net_minor >= 0),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor BETWEEN 0 AND gross_minor),
  points_snapshot bigint NOT NULL DEFAULT 0 CHECK (points_snapshot >= 0),
  bonus_snapshot bigint NOT NULL DEFAULT 0 CHECK (bonus_snapshot >= 0),
  refunded_points bigint NOT NULL DEFAULT 0 CHECK (refunded_points >= 0),
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'refunded')),
  purchased_at timestamptz NOT NULL,
  expires_at timestamptz,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (store, application_id, environment, external_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id),
  CHECK ((kind = 'membership' AND expires_at > purchased_at AND points_snapshot = 0 AND bonus_snapshot = 0)
    OR (kind = 'points_topup' AND expires_at IS NULL AND points_snapshot > 0))
);
CREATE INDEX IF NOT EXISTS native_store_token_lookup ON native_store_transactions(tenant_id, store, token_hash);
CREATE TABLE IF NOT EXISTS native_refund_debts (
  transaction_id uuid PRIMARY KEY REFERENCES native_store_transactions(id),
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  points bigint NOT NULL CHECK (points >= 0),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS native_store_product_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  store text NOT NULL CHECK (store IN ('apple', 'google')),
  application_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('Sandbox', 'Production')),
  store_product_id text NOT NULL,
  product_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('membership', 'points_topup')),
  points bigint NOT NULL CHECK (points >= 0),
  bonus bigint NOT NULL CHECK (bonus >= 0),
  PRIMARY KEY(tenant_id, store, application_id, environment, store_product_id)
);
DROP TRIGGER IF EXISTS native_sku_immutable ON native_store_product_snapshots;
CREATE TRIGGER native_sku_immutable BEFORE UPDATE OR DELETE ON native_store_product_snapshots FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

ALTER TABLE entitlements ADD COLUMN IF NOT EXISTS source_native_transaction_id uuid;
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_native_fk;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_native_fk FOREIGN KEY (tenant_id, source_native_transaction_id)
  REFERENCES native_store_transactions(tenant_id, id);
-- Preserve the existing source constraints verbatim as the non-native branch.
ALTER TABLE entitlements RENAME CONSTRAINT entitlements_source_check TO entitlements_source_check_legacy;
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO original FROM pg_constraint
    WHERE conrelid = 'entitlements'::regclass AND conname = 'entitlements_source_check_legacy';
  EXECUTE 'ALTER TABLE entitlements DROP CONSTRAINT entitlements_source_check_legacy';
  EXECUTE 'ALTER TABLE entitlements ADD CONSTRAINT entitlements_source_check CHECK ((source_native_transaction_id IS NULL AND '
    || substring(original FROM 7) || ') OR (source_type = ''native_store'' AND source_native_transaction_id IS NOT NULL'
    || ' AND source_order_id IS NULL AND source_order_item_id IS NULL AND source_point_unlock_id IS NULL AND source_rewarded_unlock_id IS NULL))';
END
$migration$;
DROP TRIGGER IF EXISTS entitlements_enforce_source ON entitlements;
CREATE TRIGGER entitlements_enforce_source
BEFORE INSERT OR UPDATE OF tenant_id, account_id, entitlement_type, product_id,
  source_type, source_order_id, source_order_item_id, source_point_unlock_id, source_rewarded_unlock_id
ON entitlements FOR EACH ROW WHEN (NEW.source_type <> 'native_store') EXECUTE FUNCTION app.enforce_entitlement_source();
DROP INDEX IF EXISTS entitlements_active_product_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_active_product_unique_idx
  ON entitlements(tenant_id, account_id, entitlement_type, product_id)
  WHERE revoked_at IS NULL AND source_type <> 'native_store';
CREATE UNIQUE INDEX IF NOT EXISTS entitlements_native_period_unique ON entitlements(source_native_transaction_id, expires_at)
  WHERE source_native_transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_native_entitlement() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_native_transaction_id IS DISTINCT FROM OLD.source_native_transaction_id THEN
    RAISE EXCEPTION 'Native entitlement source is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.source_type = 'native_store' AND NOT EXISTS (
    SELECT 1 FROM native_store_transactions AS purchase WHERE purchase.id = NEW.source_native_transaction_id
      AND purchase.tenant_id = NEW.tenant_id AND purchase.account_id = NEW.account_id
      AND purchase.product_id = NEW.product_id AND purchase.kind = 'membership' AND NEW.entitlement_type = 'membership'
      AND purchase.status = 'active' AND NEW.expires_at = purchase.expires_at AND NEW.starts_at = purchase.purchased_at
  ) THEN RAISE EXCEPTION 'Native entitlement is not backed by a verified purchase' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS entitlements_enforce_native ON entitlements;
CREATE TRIGGER entitlements_enforce_native BEFORE INSERT OR UPDATE OF source_native_transaction_id ON entitlements
  FOR EACH ROW EXECUTE FUNCTION app.enforce_native_entitlement();

CREATE OR REPLACE FUNCTION app.enforce_native_point_credit() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.reference_type = 'native_store_transaction' AND NEW.entry_type = 'topup' AND NOT EXISTS (
    SELECT 1 FROM native_store_transactions AS purchase WHERE purchase.id = NEW.reference_id
      AND purchase.tenant_id = NEW.tenant_id AND purchase.account_id = NEW.account_id
      AND purchase.kind = 'points_topup' AND purchase.status = 'active'
      AND NEW.delta = purchase.points_snapshot + purchase.bonus_snapshot
  ) THEN RAISE EXCEPTION 'Native point credit is not backed by a verified purchase' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS point_ledger_native_source ON point_ledger;
CREATE TRIGGER point_ledger_native_source BEFORE INSERT ON point_ledger
  FOR EACH ROW EXECUTE FUNCTION app.enforce_native_point_credit();
CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_native_topup_unique ON point_ledger(tenant_id, reference_id)
  WHERE reference_type = 'native_store_transaction' AND entry_type = 'topup';

DO $rls$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['native_purchase_accounts', 'native_store_transactions', 'native_refund_debts', 'native_store_product_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS native_platform ON %I', target);
    EXECUTE format('CREATE POLICY native_platform ON %I FOR ALL USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user))', target);
    EXECUTE format('DROP POLICY IF EXISTS native_tenant_read ON %I', target);
    EXECUTE format('CREATE POLICY native_tenant_read ON %I FOR SELECT USING (tenant_id = app.current_tenant_id())', target);
  END LOOP;
END
$rls$;
