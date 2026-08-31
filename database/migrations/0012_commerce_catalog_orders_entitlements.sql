BEGIN;

CREATE TABLE IF NOT EXISTS membership_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code citext NOT NULL,
  duration_days integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT membership_plans_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT membership_plans_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT membership_plans_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT membership_plans_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT membership_plans_duration_check CHECK (duration_days BETWEEN 1 AND 3650),
  CONSTRAINT membership_plans_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT membership_plans_version_check CHECK (version >= 0),
  CONSTRAINT membership_plans_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS membership_plans_tenant_status_idx
  ON membership_plans (tenant_id, status, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS membership_plans_set_updated_at ON membership_plans;
CREATE TRIGGER membership_plans_set_updated_at
BEFORE UPDATE ON membership_plans
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS membership_plan_translations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  locale text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT membership_plan_translations_plan_fk FOREIGN KEY (tenant_id, plan_id)
    REFERENCES membership_plans (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT membership_plan_translations_unique UNIQUE (plan_id, locale),
  CONSTRAINT membership_plan_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT membership_plan_translations_name_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT membership_plan_translations_description_check CHECK (
    char_length(description) <= 4000
  ),
  CONSTRAINT membership_plan_translations_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS membership_plan_translations_set_updated_at
  ON membership_plan_translations;
CREATE TRIGGER membership_plan_translations_set_updated_at
BEFORE UPDATE ON membership_plan_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS membership_plan_prices (
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT membership_plan_prices_pk PRIMARY KEY (plan_id, currency),
  CONSTRAINT membership_plan_prices_plan_fk FOREIGN KEY (tenant_id, plan_id)
    REFERENCES membership_plans (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT membership_plan_prices_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT membership_plan_prices_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT membership_plan_prices_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT membership_plan_prices_version_check CHECK (version >= 0),
  CONSTRAINT membership_plan_prices_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS membership_plan_prices_tenant_currency_idx
  ON membership_plan_prices (tenant_id, currency, status, plan_id);

DROP TRIGGER IF EXISTS membership_plan_prices_set_updated_at ON membership_plan_prices;
CREATE TRIGGER membership_plan_prices_set_updated_at
BEFORE UPDATE ON membership_plan_prices
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS content_prices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT content_prices_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_prices_unique UNIQUE (tenant_id, target_type, target_id, currency),
  CONSTRAINT content_prices_target_check CHECK (target_type IN ('drama', 'episode')),
  CONSTRAINT content_prices_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT content_prices_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT content_prices_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT content_prices_version_check CHECK (version >= 0),
  CONSTRAINT content_prices_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS content_prices_tenant_target_idx
  ON content_prices (tenant_id, target_type, target_id, status, currency);

DROP TRIGGER IF EXISTS content_prices_set_updated_at ON content_prices;
CREATE TRIGGER content_prices_set_updated_at
BEFORE UPDATE ON content_prices
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_content_price_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_available boolean;
BEGIN
  IF NEW.target_type = 'drama' THEN
    SELECT EXISTS (
      SELECT 1
      FROM dramas AS drama
      WHERE drama.id = NEW.target_id
        AND drama.status = 'published'
        AND drama.deleted_at IS NULL
        AND (
          (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
          OR (
            drama.owner_type = 'platform'
            AND EXISTS (
              SELECT 1
              FROM content_license_items AS item
              INNER JOIN content_licenses AS license
                ON license.id = item.license_id
                AND license.tenant_id = item.tenant_id
              WHERE item.tenant_id = NEW.tenant_id
                AND item.drama_id = drama.id
                AND license.status IN ('scheduled', 'active')
                AND license.revoked_at IS NULL
                AND license.starts_at <= statement_timestamp()
                AND license.expires_at > statement_timestamp()
            )
          )
        )
    ) INTO target_available;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM episodes AS episode
      INNER JOIN dramas AS drama ON drama.id = episode.drama_id
      WHERE episode.id = NEW.target_id
        AND episode.status = 'published'
        AND episode.deleted_at IS NULL
        AND drama.status = 'published'
        AND drama.deleted_at IS NULL
        AND (
          (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
          OR (
            drama.owner_type = 'platform'
            AND EXISTS (
              SELECT 1
              FROM content_license_items AS item
              INNER JOIN content_licenses AS license
                ON license.id = item.license_id
                AND license.tenant_id = item.tenant_id
              WHERE item.tenant_id = NEW.tenant_id
                AND item.drama_id = drama.id
                AND license.status IN ('scheduled', 'active')
                AND license.revoked_at IS NULL
                AND license.starts_at <= statement_timestamp()
                AND license.expires_at > statement_timestamp()
            )
          )
        )
    ) INTO target_available;
  END IF;

  IF target_available IS NOT TRUE THEN
    RAISE EXCEPTION 'Priced content is not published or licensed for this tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_prices_enforce_target ON content_prices;
CREATE TRIGGER content_prices_enforce_target
BEFORE INSERT OR UPDATE OF tenant_id, target_type, target_id ON content_prices
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_price_target();

CREATE TABLE IF NOT EXISTS points_topup_packages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  code citext NOT NULL,
  points_amount bigint NOT NULL,
  bonus_points bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT points_topup_packages_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT points_topup_packages_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT points_topup_packages_code_unique UNIQUE (tenant_id, code),
  CONSTRAINT points_topup_packages_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9_-]{1,63}$'
  ),
  CONSTRAINT points_topup_packages_points_check CHECK (
    points_amount BETWEEN 1 AND 9000000000000000
    AND bonus_points BETWEEN 0 AND 9000000000000000
    AND points_amount <= 9000000000000000 - bonus_points
  ),
  CONSTRAINT points_topup_packages_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT points_topup_packages_version_check CHECK (version >= 0),
  CONSTRAINT points_topup_packages_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS points_topup_packages_tenant_status_idx
  ON points_topup_packages (tenant_id, status, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS points_topup_packages_set_updated_at ON points_topup_packages;
CREATE TRIGGER points_topup_packages_set_updated_at
BEFORE UPDATE ON points_topup_packages
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS points_topup_package_translations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  locale text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT points_topup_package_translations_package_fk
    FOREIGN KEY (tenant_id, package_id)
    REFERENCES points_topup_packages (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT points_topup_package_translations_unique UNIQUE (package_id, locale),
  CONSTRAINT points_topup_package_translations_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT points_topup_package_translations_name_check CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT points_topup_package_translations_description_check CHECK (
    char_length(description) <= 4000
  ),
  CONSTRAINT points_topup_package_translations_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS points_topup_package_translations_set_updated_at
  ON points_topup_package_translations;
CREATE TRIGGER points_topup_package_translations_set_updated_at
BEFORE UPDATE ON points_topup_package_translations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS points_topup_package_prices (
  tenant_id uuid NOT NULL,
  package_id uuid NOT NULL,
  currency text NOT NULL,
  amount_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT points_topup_package_prices_pk PRIMARY KEY (package_id, currency),
  CONSTRAINT points_topup_package_prices_package_fk FOREIGN KEY (tenant_id, package_id)
    REFERENCES points_topup_packages (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT points_topup_package_prices_currency_check CHECK (
    currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')
  ),
  CONSTRAINT points_topup_package_prices_amount_check CHECK (
    amount_minor BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT points_topup_package_prices_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT points_topup_package_prices_version_check CHECK (version >= 0),
  CONSTRAINT points_topup_package_prices_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS points_topup_package_prices_tenant_currency_idx
  ON points_topup_package_prices (tenant_id, currency, status, package_id);

DROP TRIGGER IF EXISTS points_topup_package_prices_set_updated_at
  ON points_topup_package_prices;
CREATE TRIGGER points_topup_package_prices_set_updated_at
BEFORE UPDATE ON points_topup_package_prices
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS point_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  balance bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT point_accounts_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT point_accounts_unique UNIQUE (tenant_id, account_id),
  CONSTRAINT point_accounts_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT point_accounts_balance_check CHECK (balance BETWEEN 0 AND 9000000000000000),
  CONSTRAINT point_accounts_version_check CHECK (version >= 0),
  CONSTRAINT point_accounts_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS point_accounts_set_updated_at ON point_accounts;
CREATE TRIGGER point_accounts_set_updated_at
BEFORE UPDATE ON point_accounts
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.prevent_direct_point_balance_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 THEN
      RAISE EXCEPTION 'New point accounts must start with a zero balance'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'Point balances may only be changed by appending a ledger entry'
        USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS point_accounts_enforce_initial_balance ON point_accounts;
CREATE TRIGGER point_accounts_enforce_initial_balance
BEFORE INSERT ON point_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_point_balance_update();

DROP TRIGGER IF EXISTS point_accounts_prevent_direct_balance_update ON point_accounts;
CREATE TRIGGER point_accounts_prevent_direct_balance_update
BEFORE UPDATE OF balance ON point_accounts
FOR EACH ROW EXECUTE FUNCTION app.prevent_direct_point_balance_update();

CREATE TABLE IF NOT EXISTS point_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  point_account_id uuid NOT NULL,
  entry_type text NOT NULL,
  delta bigint NOT NULL,
  balance_after bigint NOT NULL,
  reference_type text NOT NULL,
  reference_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by_type text NOT NULL,
  created_by uuid,
  CONSTRAINT point_ledger_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT point_ledger_point_account_fk FOREIGN KEY (tenant_id, point_account_id)
    REFERENCES point_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT point_ledger_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT point_ledger_entry_type_check CHECK (
    entry_type IN ('topup', 'purchase', 'refund', 'adjustment')
  ),
  CONSTRAINT point_ledger_delta_check CHECK (
    delta <> 0 AND delta BETWEEN -9000000000000000 AND 9000000000000000
  ),
  CONSTRAINT point_ledger_balance_check CHECK (balance_after BETWEEN 0 AND 9000000000000000),
  CONSTRAINT point_ledger_reference_type_check CHECK (
    reference_type ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  CONSTRAINT point_ledger_idempotency_key_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT point_ledger_metadata_check CHECK (jsonb_typeof(metadata_json) = 'object'),
  CONSTRAINT point_ledger_actor_check CHECK (
    created_by_type IN ('system', 'platform_staff', 'tenant_staff', 'user')
    AND (created_by_type = 'system' OR created_by IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS point_ledger_account_history_idx
  ON point_ledger (tenant_id, account_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION app.apply_point_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_account point_accounts%ROWTYPE;
  next_balance bigint;
BEGIN
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

DROP TRIGGER IF EXISTS point_ledger_apply_balance ON point_ledger;
CREATE TRIGGER point_ledger_apply_balance
BEFORE INSERT ON point_ledger
FOR EACH ROW EXECUTE FUNCTION app.apply_point_ledger_entry();

DROP TRIGGER IF EXISTS point_ledger_prevent_mutation ON point_ledger;
CREATE TRIGGER point_ledger_prevent_mutation
BEFORE UPDATE OR DELETE ON point_ledger
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  order_no text NOT NULL,
  order_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment',
  currency text NOT NULL,
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  locale text NOT NULL,
  customer_snapshot_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT orders_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT orders_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT orders_order_no_unique UNIQUE (tenant_id, order_no),
  CONSTRAINT orders_order_no_check CHECK (order_no ~ '^ORD[0-9A-F]{26}$'),
  CONSTRAINT orders_type_check CHECK (
    order_type IN ('membership', 'drama', 'episode', 'points_topup')
  ),
  CONSTRAINT orders_status_check CHECK (
    status IN ('pending_payment', 'paid', 'expired', 'cancelled', 'refunded')
  ),
  CONSTRAINT orders_currency_check CHECK (currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')),
  CONSTRAINT orders_amount_check CHECK (
    subtotal_minor BETWEEN 1 AND 9000000000000000
    AND discount_minor BETWEEN 0 AND subtotal_minor
    AND total_minor = subtotal_minor - discount_minor
    AND total_minor > 0
  ),
  CONSTRAINT orders_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT orders_snapshot_check CHECK (jsonb_typeof(customer_snapshot_json) = 'object'),
  CONSTRAINT orders_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT orders_lifecycle_check CHECK (
    (status = 'pending_payment' AND paid_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
    OR (
      status = 'paid' AND paid_at IS NOT NULL AND paid_at <= expires_at
      AND cancelled_at IS NULL AND refunded_at IS NULL
    )
    OR (status = 'expired' AND paid_at IS NULL AND cancelled_at IS NULL AND refunded_at IS NULL)
    OR (status = 'cancelled' AND paid_at IS NULL AND cancelled_at IS NOT NULL AND refunded_at IS NULL)
    OR (
      status = 'refunded' AND paid_at IS NOT NULL AND paid_at <= expires_at
      AND cancelled_at IS NULL AND refunded_at IS NOT NULL
      AND refunded_at >= paid_at
    )
  ),
  CONSTRAINT orders_version_check CHECK (version >= 0),
  CONSTRAINT orders_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS orders_customer_history_idx
  ON orders (tenant_id, account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_pending_expiry_idx
  ON orders (expires_at, id) WHERE status = 'pending_payment';
CREATE INDEX IF NOT EXISTS orders_tenant_status_idx
  ON orders (tenant_id, status, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

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
      IF OLD.expires_at <= statement_timestamp() THEN
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

DROP TRIGGER IF EXISTS orders_protect_snapshot ON orders;
CREATE TRIGGER orders_protect_snapshot
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION app.protect_order_snapshot();

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no integer NOT NULL,
  item_type text NOT NULL,
  product_id uuid NOT NULL,
  quantity integer NOT NULL DEFAULT 1,
  currency text NOT NULL,
  unit_amount_minor bigint NOT NULL,
  total_amount_minor bigint NOT NULL,
  product_snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT order_items_order_fk FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT order_items_order_line_unique UNIQUE (order_id, line_no),
  CONSTRAINT order_items_order_product_unique UNIQUE (order_id, item_type, product_id),
  CONSTRAINT order_items_line_check CHECK (line_no BETWEEN 1 AND 100),
  CONSTRAINT order_items_type_check CHECK (
    item_type IN ('membership', 'drama', 'episode', 'points_topup')
  ),
  CONSTRAINT order_items_quantity_check CHECK (quantity BETWEEN 1 AND 1000),
  CONSTRAINT order_items_currency_check CHECK (currency IN ('CNY', 'USD', 'EUR', 'JPY', 'KRW')),
  CONSTRAINT order_items_amount_check CHECK (
    unit_amount_minor BETWEEN 1 AND 9000000000000000
    AND total_amount_minor BETWEEN 1 AND 9000000000000000
    AND total_amount_minor = unit_amount_minor * quantity
  ),
  CONSTRAINT order_items_snapshot_check CHECK (jsonb_typeof(product_snapshot_json) = 'object')
);

CREATE INDEX IF NOT EXISTS order_items_tenant_order_idx
  ON order_items (tenant_id, order_id, line_no);

CREATE OR REPLACE FUNCTION app.enforce_order_item_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent orders%ROWTYPE;
BEGIN
  SELECT * INTO parent
  FROM orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND
    OR parent.status <> 'pending_payment'
    OR parent.order_type <> NEW.item_type
    OR parent.currency <> NEW.currency
    OR parent.total_minor <> NEW.total_amount_minor
  THEN
    RAISE EXCEPTION 'Order item does not match its pending order snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS order_items_enforce_snapshot ON order_items;
CREATE TRIGGER order_items_enforce_snapshot
BEFORE INSERT ON order_items
FOR EACH ROW EXECUTE FUNCTION app.enforce_order_item_snapshot();

DROP TRIGGER IF EXISTS order_items_prevent_mutation ON order_items;
CREATE TRIGGER order_items_prevent_mutation
BEFORE UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS entitlements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  entitlement_type text NOT NULL,
  product_id uuid NOT NULL,
  source_order_id uuid NOT NULL,
  source_order_item_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT entitlements_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT entitlements_order_fk FOREIGN KEY (tenant_id, source_order_id)
    REFERENCES orders (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT entitlements_order_item_fk FOREIGN KEY (source_order_item_id)
    REFERENCES order_items (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT entitlements_order_item_unique UNIQUE (source_order_item_id),
  CONSTRAINT entitlements_type_check CHECK (
    entitlement_type IN ('membership', 'drama', 'episode')
  ),
  CONSTRAINT entitlements_period_check CHECK (
    expires_at IS NULL OR expires_at > starts_at
  ),
  CONSTRAINT entitlements_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (
      revoked_at IS NOT NULL AND revoked_at >= starts_at
      AND revoked_reason IS NOT NULL
      AND char_length(btrim(revoked_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT entitlements_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_active_product_unique_idx
  ON entitlements (tenant_id, account_id, entitlement_type, product_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS entitlements_effective_idx
  ON entitlements (tenant_id, account_id, entitlement_type, starts_at, expires_at)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS entitlements_set_updated_at ON entitlements;
CREATE TRIGGER entitlements_set_updated_at
BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_entitlement_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM orders AS commerce_order
    INNER JOIN order_items AS item
      ON item.order_id = commerce_order.id
      AND item.tenant_id = commerce_order.tenant_id
    WHERE commerce_order.id = NEW.source_order_id
      AND commerce_order.tenant_id = NEW.tenant_id
      AND commerce_order.account_id = NEW.account_id
      AND commerce_order.status = 'paid'
      AND item.id = NEW.source_order_item_id
      AND item.item_type = NEW.entitlement_type
      AND item.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'Entitlement source is not a matching paid order item'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS entitlements_enforce_source ON entitlements;
CREATE TRIGGER entitlements_enforce_source
BEFORE INSERT OR UPDATE OF tenant_id, account_id, entitlement_type, product_id,
  source_order_id, source_order_item_id
ON entitlements
FOR EACH ROW EXECUTE FUNCTION app.enforce_entitlement_source();

-- Every commerce table is tenant-isolated. Platform access is granted only to
-- database roles previously registered through app.register_platform_role().
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_plans_tenant_access ON membership_plans;
CREATE POLICY membership_plans_tenant_access ON membership_plans FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS membership_plans_platform_access ON membership_plans;
CREATE POLICY membership_plans_platform_access ON membership_plans FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE membership_plan_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plan_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_plan_translations_tenant_access ON membership_plan_translations;
CREATE POLICY membership_plan_translations_tenant_access ON membership_plan_translations FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS membership_plan_translations_platform_access ON membership_plan_translations;
CREATE POLICY membership_plan_translations_platform_access ON membership_plan_translations FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE membership_plan_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plan_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_plan_prices_tenant_access ON membership_plan_prices;
CREATE POLICY membership_plan_prices_tenant_access ON membership_plan_prices FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS membership_plan_prices_platform_access ON membership_plan_prices;
CREATE POLICY membership_plan_prices_platform_access ON membership_plan_prices FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_prices_tenant_access ON content_prices;
CREATE POLICY content_prices_tenant_access ON content_prices FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_prices_platform_access ON content_prices;
CREATE POLICY content_prices_platform_access ON content_prices FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE points_topup_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_topup_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS points_topup_packages_tenant_access ON points_topup_packages;
CREATE POLICY points_topup_packages_tenant_access ON points_topup_packages FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS points_topup_packages_platform_access ON points_topup_packages;
CREATE POLICY points_topup_packages_platform_access ON points_topup_packages FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE points_topup_package_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_topup_package_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS points_topup_package_translations_tenant_access
  ON points_topup_package_translations;
CREATE POLICY points_topup_package_translations_tenant_access
  ON points_topup_package_translations FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS points_topup_package_translations_platform_access
  ON points_topup_package_translations;
CREATE POLICY points_topup_package_translations_platform_access
  ON points_topup_package_translations FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE points_topup_package_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE points_topup_package_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS points_topup_package_prices_tenant_access
  ON points_topup_package_prices;
CREATE POLICY points_topup_package_prices_tenant_access
  ON points_topup_package_prices FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS points_topup_package_prices_platform_access
  ON points_topup_package_prices;
CREATE POLICY points_topup_package_prices_platform_access
  ON points_topup_package_prices FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE point_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS point_accounts_tenant_access ON point_accounts;
CREATE POLICY point_accounts_tenant_access ON point_accounts FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS point_accounts_platform_access ON point_accounts;
CREATE POLICY point_accounts_platform_access ON point_accounts FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE point_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS point_ledger_tenant_access ON point_ledger;
CREATE POLICY point_ledger_tenant_access ON point_ledger FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS point_ledger_platform_access ON point_ledger;
CREATE POLICY point_ledger_platform_access ON point_ledger FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orders_tenant_access ON orders;
CREATE POLICY orders_tenant_access ON orders FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS orders_platform_access ON orders;
CREATE POLICY orders_platform_access ON orders FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_items_tenant_access ON order_items;
CREATE POLICY order_items_tenant_access ON order_items FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS order_items_platform_access ON order_items;
CREATE POLICY order_items_platform_access ON order_items FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlements_tenant_access ON entitlements;
CREATE POLICY entitlements_tenant_access ON entitlements FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS entitlements_platform_access ON entitlements;
CREATE POLICY entitlements_platform_access ON entitlements FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.enforce_content_price_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_direct_point_balance_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.apply_point_ledger_entry() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protect_order_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_order_item_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_entitlement_source() FROM PUBLIC;

COMMIT;
