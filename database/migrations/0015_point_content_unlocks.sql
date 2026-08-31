BEGIN;

CREATE TABLE IF NOT EXISTS content_point_prices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  points_amount bigint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by uuid,
  CONSTRAINT content_point_prices_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT content_point_prices_unique UNIQUE (tenant_id, target_type, target_id),
  CONSTRAINT content_point_prices_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT content_point_prices_target_type_check CHECK (
    target_type IN ('drama', 'episode')
  ),
  CONSTRAINT content_point_prices_amount_check CHECK (
    points_amount BETWEEN 1 AND 9000000000000000
  ),
  CONSTRAINT content_point_prices_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT content_point_prices_version_check CHECK (version >= 0),
  CONSTRAINT content_point_prices_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS content_point_prices_tenant_target_idx
  ON content_point_prices (tenant_id, target_type, target_id, status);

DROP TRIGGER IF EXISTS content_point_prices_set_updated_at ON content_point_prices;
CREATE TRIGGER content_point_prices_set_updated_at
BEFORE UPDATE ON content_point_prices
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.enforce_content_point_price_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_available boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.target_type IS DISTINCT FROM OLD.target_type
    OR NEW.target_id IS DISTINCT FROM OLD.target_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Point price target identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'disabled' THEN
    RETURN NEW;
  END IF;

  IF NEW.target_type = 'drama' THEN
    SELECT EXISTS (
      SELECT 1 FROM dramas AS drama
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
                AND license.starts_at <= transaction_timestamp()
                AND license.expires_at > transaction_timestamp()
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
                AND license.starts_at <= transaction_timestamp()
                AND license.expires_at > transaction_timestamp()
            )
          )
        )
    ) INTO target_available;
  END IF;

  IF NOT coalesce(target_available, false) THEN
    RAISE EXCEPTION 'Point price target is not currently published and licensed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_point_prices_enforce_target ON content_point_prices;
CREATE TRIGGER content_point_prices_enforce_target
BEFORE INSERT OR UPDATE OF tenant_id, target_type, target_id, points_amount, status
ON content_point_prices
FOR EACH ROW EXECUTE FUNCTION app.enforce_content_point_price_target();

CREATE TABLE IF NOT EXISTS point_unlocks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  point_account_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  price_id uuid NOT NULL,
  price_version_snapshot integer NOT NULL,
  points_amount_snapshot bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT point_unlocks_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT point_unlocks_point_account_fk FOREIGN KEY (tenant_id, point_account_id)
    REFERENCES point_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT point_unlocks_price_fk FOREIGN KEY (tenant_id, price_id)
    REFERENCES content_point_prices (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT point_unlocks_unique UNIQUE (tenant_id, account_id, target_type, target_id),
  CONSTRAINT point_unlocks_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT point_unlocks_target_type_check CHECK (target_type IN ('drama', 'episode')),
  CONSTRAINT point_unlocks_drama_binding_check CHECK (
    target_type <> 'drama' OR drama_id = target_id
  ),
  CONSTRAINT point_unlocks_price_version_check CHECK (price_version_snapshot >= 0),
  CONSTRAINT point_unlocks_amount_check CHECK (
    points_amount_snapshot BETWEEN 1 AND 9000000000000000
  )
);

CREATE INDEX IF NOT EXISTS point_unlocks_customer_history_idx
  ON point_unlocks (tenant_id, account_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS point_unlocks_target_idx
  ON point_unlocks (tenant_id, target_type, target_id, created_at DESC);

DROP TRIGGER IF EXISTS point_unlocks_prevent_mutation ON point_unlocks;
CREATE TRIGGER point_unlocks_prevent_mutation
BEFORE UPDATE OR DELETE ON point_unlocks
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE OR REPLACE FUNCTION app.enforce_point_unlock_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  resolved_drama_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM point_accounts AS account
    WHERE account.tenant_id = NEW.tenant_id
      AND account.account_id = NEW.account_id
      AND account.id = NEW.point_account_id
  ) THEN
    RAISE EXCEPTION 'Point unlock account binding is invalid' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM content_point_prices AS price
    WHERE price.tenant_id = NEW.tenant_id
      AND price.id = NEW.price_id
      AND price.target_type = NEW.target_type
      AND price.target_id = NEW.target_id
      AND price.status = 'active'
      AND price.version = NEW.price_version_snapshot
      AND price.points_amount = NEW.points_amount_snapshot
  ) THEN
    RAISE EXCEPTION 'Point unlock price snapshot is invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.target_type = 'drama' THEN
    SELECT drama.id INTO resolved_drama_id
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
              AND license.starts_at <= transaction_timestamp()
              AND license.expires_at > transaction_timestamp()
          )
        )
      );
  ELSE
    SELECT drama.id INTO resolved_drama_id
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
              AND license.starts_at <= transaction_timestamp()
              AND license.expires_at > transaction_timestamp()
          )
        )
      );
  END IF;

  IF resolved_drama_id IS NULL OR resolved_drama_id <> NEW.drama_id THEN
    RAISE EXCEPTION 'Point unlock target is not currently sellable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS point_unlocks_enforce_snapshot ON point_unlocks;
CREATE TRIGGER point_unlocks_enforce_snapshot
BEFORE INSERT ON point_unlocks
FOR EACH ROW EXECUTE FUNCTION app.enforce_point_unlock_snapshot();

ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'order';
ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS source_point_unlock_id uuid;
ALTER TABLE entitlements ALTER COLUMN source_order_id DROP NOT NULL;
ALTER TABLE entitlements ALTER COLUMN source_order_item_id DROP NOT NULL;
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_source_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_source_check CHECK (
  (
    source_type = 'order'
    AND source_order_id IS NOT NULL
    AND source_order_item_id IS NOT NULL
    AND source_point_unlock_id IS NULL
  )
  OR (
    source_type = 'point_unlock'
    AND source_order_id IS NULL
    AND source_order_item_id IS NULL
    AND source_point_unlock_id IS NOT NULL
  )
);
ALTER TABLE entitlements
  DROP CONSTRAINT IF EXISTS entitlements_point_unlock_fk;
ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_point_unlock_fk
  FOREIGN KEY (tenant_id, source_point_unlock_id)
  REFERENCES point_unlocks (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_point_unlock_unique_idx
  ON entitlements (source_point_unlock_id)
  WHERE source_point_unlock_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_entitlement_source()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.source_type = 'order' THEN
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
  ELSIF NEW.source_type = 'point_unlock' THEN
    IF NEW.entitlement_type NOT IN ('drama', 'episode') OR NOT EXISTS (
      SELECT 1
      FROM point_unlocks AS unlock
      INNER JOIN point_ledger AS ledger
        ON ledger.tenant_id = unlock.tenant_id
        AND ledger.account_id = unlock.account_id
        AND ledger.point_account_id = unlock.point_account_id
        AND ledger.reference_type = 'point_unlock'
        AND ledger.reference_id = unlock.id
        AND ledger.entry_type = 'purchase'
        AND ledger.delta = -unlock.points_amount_snapshot
      WHERE unlock.id = NEW.source_point_unlock_id
        AND unlock.tenant_id = NEW.tenant_id
        AND unlock.account_id = NEW.account_id
        AND unlock.target_type = NEW.entitlement_type
        AND unlock.target_id = NEW.product_id
        AND NEW.starts_at = unlock.created_at
        AND NEW.expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Entitlement source is not a matching point unlock'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Entitlement source type is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS entitlements_enforce_source ON entitlements;
CREATE TRIGGER entitlements_enforce_source
BEFORE INSERT OR UPDATE OF tenant_id, account_id, entitlement_type, product_id,
  source_type, source_order_id, source_order_item_id, source_point_unlock_id
ON entitlements
FOR EACH ROW EXECUTE FUNCTION app.enforce_entitlement_source();

CREATE OR REPLACE FUNCTION app.protect_entitlement_source_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.entitlement_type IS DISTINCT FROM OLD.entitlement_type
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.source_type IS DISTINCT FROM OLD.source_type
    OR NEW.source_order_id IS DISTINCT FROM OLD.source_order_id
    OR NEW.source_order_item_id IS DISTINCT FROM OLD.source_order_item_id
    OR NEW.source_point_unlock_id IS DISTINCT FROM OLD.source_point_unlock_id
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Entitlement source snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS entitlements_protect_source_snapshot ON entitlements;
CREATE TRIGGER entitlements_protect_source_snapshot
BEFORE UPDATE ON entitlements
FOR EACH ROW EXECUTE FUNCTION app.protect_entitlement_source_snapshot();

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

CREATE UNIQUE INDEX IF NOT EXISTS point_ledger_unlock_purchase_unique_idx
  ON point_ledger (tenant_id, account_id, reference_type, reference_id, entry_type)
  WHERE reference_type = 'point_unlock' AND entry_type = 'purchase';

CREATE OR REPLACE FUNCTION app.validate_point_unlock_fulfillment()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM point_ledger AS ledger
    WHERE ledger.tenant_id = NEW.tenant_id
      AND ledger.account_id = NEW.account_id
      AND ledger.point_account_id = NEW.point_account_id
      AND ledger.reference_type = 'point_unlock'
      AND ledger.reference_id = NEW.id
      AND ledger.entry_type = 'purchase'
      AND ledger.delta = -NEW.points_amount_snapshot
  ) OR NOT EXISTS (
    SELECT 1 FROM entitlements AS entitlement
    WHERE entitlement.tenant_id = NEW.tenant_id
      AND entitlement.account_id = NEW.account_id
      AND entitlement.source_type = 'point_unlock'
      AND entitlement.source_point_unlock_id = NEW.id
      AND entitlement.entitlement_type = NEW.target_type
      AND entitlement.product_id = NEW.target_id
  ) THEN
    RAISE EXCEPTION 'Point unlock requires a balanced ledger purchase and entitlement'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS point_unlocks_require_fulfillment ON point_unlocks;
CREATE CONSTRAINT TRIGGER point_unlocks_require_fulfillment
AFTER INSERT ON point_unlocks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.validate_point_unlock_fulfillment();

ALTER TABLE content_point_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_point_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_point_prices_tenant_access ON content_point_prices;
CREATE POLICY content_point_prices_tenant_access ON content_point_prices FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_point_prices_platform_access ON content_point_prices;
CREATE POLICY content_point_prices_platform_access ON content_point_prices FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE point_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_unlocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS point_unlocks_tenant_access ON point_unlocks;
CREATE POLICY point_unlocks_tenant_access ON point_unlocks FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS point_unlocks_platform_access ON point_unlocks;
CREATE POLICY point_unlocks_platform_access ON point_unlocks FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

DROP POLICY IF EXISTS point_accounts_tenant_access ON point_accounts;
CREATE POLICY point_accounts_tenant_access ON point_accounts FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS point_ledger_tenant_access ON point_ledger;
CREATE POLICY point_ledger_tenant_access ON point_ledger FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS entitlements_tenant_access ON entitlements;
CREATE POLICY entitlements_tenant_access ON entitlements FOR SELECT
  USING (tenant_id = app.current_tenant_id());

REVOKE ALL ON FUNCTION app.enforce_content_point_price_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_point_unlock_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protect_entitlement_source_snapshot() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.validate_point_unlock_fulfillment() FROM PUBLIC;

COMMIT;
