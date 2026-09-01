BEGIN;

CREATE TABLE IF NOT EXISTS customer_drama_likes (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, account_id, drama_id),
  CONSTRAINT customer_drama_likes_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_drama_likes_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS customer_drama_likes_count_idx
  ON customer_drama_likes (tenant_id, drama_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rewarded_episode_unlocks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'admob',
  placement_key text NOT NULL,
  ad_unit_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  provider_transaction_id text,
  reward_amount bigint,
  reward_item text,
  expires_at timestamptz NOT NULL,
  granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT rewarded_episode_unlocks_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT rewarded_episode_unlocks_customer_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT rewarded_episode_unlocks_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT rewarded_episode_unlocks_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT rewarded_episode_unlocks_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT rewarded_episode_unlocks_provider_check CHECK (provider = 'admob'),
  CONSTRAINT rewarded_episode_unlocks_status_check CHECK (
    status IN ('pending', 'granted', 'expired')
  ),
  CONSTRAINT rewarded_episode_unlocks_placement_check CHECK (
    char_length(btrim(placement_key)) BETWEEN 1 AND 100
    AND char_length(btrim(ad_unit_id)) BETWEEN 1 AND 200
  ),
  CONSTRAINT rewarded_episode_unlocks_provider_event_check CHECK (
    provider_transaction_id IS NULL
    OR char_length(btrim(provider_transaction_id)) BETWEEN 1 AND 500
  ),
  CONSTRAINT rewarded_episode_unlocks_reward_check CHECK (
    (status = 'pending' AND provider_transaction_id IS NULL
      AND reward_amount IS NULL AND reward_item IS NULL AND granted_at IS NULL)
    OR (status = 'granted' AND provider_transaction_id IS NOT NULL
      AND reward_amount IS NOT NULL AND reward_amount > 0
      AND reward_item IS NOT NULL
      AND char_length(btrim(reward_item)) BETWEEN 1 AND 100
      AND granted_at IS NOT NULL)
    OR (status = 'expired' AND granted_at IS NULL)
  ),
  CONSTRAINT rewarded_episode_unlocks_timestamp_check CHECK (
    expires_at > created_at AND updated_at >= created_at
    AND (granted_at IS NULL OR granted_at >= created_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS rewarded_episode_unlocks_provider_event_unique_idx
  ON rewarded_episode_unlocks (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rewarded_episode_unlocks_customer_idx
  ON rewarded_episode_unlocks (tenant_id, account_id, episode_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rewarded_episode_unlocks_one_pending_idx
  ON rewarded_episode_unlocks (tenant_id, account_id, episode_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rewarded_episode_unlocks_pending_idx
  ON rewarded_episode_unlocks (status, expires_at, id)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION app.enforce_rewarded_episode_unlock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM episodes AS episode
    WHERE episode.id = NEW.episode_id AND episode.drama_id = NEW.drama_id
  ) THEN
    RAISE EXCEPTION 'Rewarded unlock episode does not belong to drama'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.drama_id IS DISTINCT FROM OLD.drama_id
    OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.placement_key IS DISTINCT FROM OLD.placement_key
    OR NEW.ad_unit_id IS DISTINCT FROM OLD.ad_unit_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Rewarded unlock identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS rewarded_episode_unlocks_enforce ON rewarded_episode_unlocks;
CREATE TRIGGER rewarded_episode_unlocks_enforce
BEFORE INSERT OR UPDATE ON rewarded_episode_unlocks
FOR EACH ROW EXECUTE FUNCTION app.enforce_rewarded_episode_unlock();

DROP TRIGGER IF EXISTS rewarded_episode_unlocks_set_updated_at
  ON rewarded_episode_unlocks;
CREATE TRIGGER rewarded_episode_unlocks_set_updated_at
BEFORE UPDATE ON rewarded_episode_unlocks
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

ALTER TABLE entitlements
  ADD COLUMN IF NOT EXISTS source_rewarded_unlock_id uuid;
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_source_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_source_check CHECK (
  (
    source_type = 'order'
    AND source_order_id IS NOT NULL
    AND source_order_item_id IS NOT NULL
    AND source_point_unlock_id IS NULL
    AND source_rewarded_unlock_id IS NULL
  ) OR (
    source_type = 'point_unlock'
    AND source_order_id IS NULL
    AND source_order_item_id IS NULL
    AND source_point_unlock_id IS NOT NULL
    AND source_rewarded_unlock_id IS NULL
  ) OR (
    source_type = 'rewarded_ad'
    AND source_order_id IS NULL
    AND source_order_item_id IS NULL
    AND source_point_unlock_id IS NULL
    AND source_rewarded_unlock_id IS NOT NULL
  )
);
ALTER TABLE entitlements
  DROP CONSTRAINT IF EXISTS entitlements_rewarded_unlock_fk;
ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_rewarded_unlock_fk
  FOREIGN KEY (tenant_id, source_rewarded_unlock_id)
  REFERENCES rewarded_episode_unlocks (tenant_id, id)
  ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_rewarded_unlock_unique_idx
  ON entitlements (source_rewarded_unlock_id)
  WHERE source_rewarded_unlock_id IS NOT NULL;

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
  ELSIF NEW.source_type = 'rewarded_ad' THEN
    IF NEW.entitlement_type <> 'episode' OR NOT EXISTS (
      SELECT 1 FROM rewarded_episode_unlocks AS unlock
      WHERE unlock.id = NEW.source_rewarded_unlock_id
        AND unlock.tenant_id = NEW.tenant_id
        AND unlock.account_id = NEW.account_id
        AND unlock.episode_id = NEW.product_id
        AND unlock.status = 'granted'
        AND NEW.starts_at = unlock.granted_at
        AND NEW.expires_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Entitlement source is not a verified rewarded ad'
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
  source_type, source_order_id, source_order_item_id, source_point_unlock_id,
  source_rewarded_unlock_id
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
    OR NEW.source_rewarded_unlock_id IS DISTINCT FROM OLD.source_rewarded_unlock_id
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

ALTER TABLE customer_drama_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_drama_likes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_drama_likes_tenant_access
  ON customer_drama_likes;
CREATE POLICY customer_drama_likes_tenant_access
  ON customer_drama_likes FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_drama_likes_platform_access
  ON customer_drama_likes;
CREATE POLICY customer_drama_likes_platform_access
  ON customer_drama_likes FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE rewarded_episode_unlocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rewarded_episode_unlocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rewarded_episode_unlocks_tenant_access
  ON rewarded_episode_unlocks;
CREATE POLICY rewarded_episode_unlocks_tenant_access
  ON rewarded_episode_unlocks FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS rewarded_episode_unlocks_platform_access
  ON rewarded_episode_unlocks;
CREATE POLICY rewarded_episode_unlocks_platform_access
  ON rewarded_episode_unlocks FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMENT ON TABLE customer_drama_likes IS
  'Tenant-isolated customer likes for drama engagement counts.';
COMMENT ON TABLE rewarded_episode_unlocks IS
  'AdMob SSV challenges and verified one-episode unlock grants.';

REVOKE ALL ON FUNCTION app.enforce_rewarded_episode_unlock() FROM PUBLIC;

COMMIT;
