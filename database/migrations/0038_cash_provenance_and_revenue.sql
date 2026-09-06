BEGIN;

ALTER TABLE native_refund_debts ADD COLUMN IF NOT EXISTS paid_points bigint NOT NULL DEFAULT 0 CHECK (paid_points >= 0);
ALTER TABLE native_refund_debts ADD COLUMN IF NOT EXISTS bonus_points bigint NOT NULL DEFAULT 0 CHECK (bonus_points >= 0);
UPDATE native_refund_debts SET paid_points = points WHERE points > 0 AND paid_points + bonus_points = 0;
ALTER TABLE native_refund_debts DROP CONSTRAINT IF EXISTS native_refund_debt_parts;
ALTER TABLE native_refund_debts ADD CONSTRAINT native_refund_debt_parts CHECK (points = paid_points + bonus_points);

-- Coins are not money. Track every credit's provenance and allocate paid credits FIFO.
-- An absent basis/policy/net statement leaves an explicit unvalued event, never invented cash.
CREATE TABLE IF NOT EXISTS content_revenue_basis (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  basis text NOT NULL CHECK (basis IN ('gross', 'net')),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS content_cash_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid,
  source_type text NOT NULL CHECK (source_type IN ('native_store', 'payment', 'ad_report')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  gross_minor bigint NOT NULL CHECK (gross_minor BETWEEN 0 AND 9000000000000000),
  net_minor bigint CHECK (net_minor BETWEEN 0 AND gross_minor),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor BETWEEN 0 AND gross_minor),
  sandbox boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  UNIQUE(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
CREATE TABLE IF NOT EXISTS point_cash_lots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  credit_id uuid NOT NULL REFERENCES point_ledger(id),
  source_id uuid,
  is_cash boolean NOT NULL DEFAULT true,
  point_start bigint NOT NULL DEFAULT 0 CHECK (point_start >= 0),
  denominator bigint NOT NULL CHECK (denominator > 0),
  points bigint NOT NULL CHECK (points > 0),
  remaining bigint NOT NULL CHECK (remaining BETWEEN 0 AND points),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES content_cash_sources(tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id),
  CHECK (source_id IS NULL OR point_start + points <= denominator)
);
CREATE INDEX IF NOT EXISTS point_cash_fifo ON point_cash_lots(tenant_id, account_id, created_at, id) WHERE remaining > 0;
CREATE TABLE IF NOT EXISTS point_cash_uses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  debit_id uuid NOT NULL REFERENCES point_ledger(id),
  lot_id uuid NOT NULL REFERENCES point_cash_lots(id),
  source_id uuid,
  is_cash boolean NOT NULL DEFAULT true,
  point_start bigint NOT NULL,
  denominator bigint NOT NULL CHECK (denominator > 0),
  points bigint NOT NULL CHECK (points > 0),
  FOREIGN KEY (tenant_id, source_id) REFERENCES content_cash_sources(tenant_id, id),
  UNIQUE(debit_id, lot_id, point_start)
);
CREATE TABLE IF NOT EXISTS content_revenue_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  drama_id uuid REFERENCES dramas(id),
  episode_id uuid REFERENCES episodes(id),
  creator_id text,
  content_scope text NOT NULL CHECK (content_scope IN ('public', 'private')),
  income_type text NOT NULL CHECK (income_type IN ('coin_unlock', 'membership', 'content_ad')),
  point_start bigint NOT NULL DEFAULT 0 CHECK (point_start >= 0),
  points bigint NOT NULL CHECK (points > 0),
  denominator bigint NOT NULL CHECK (denominator >= points),
  headquarters_bps integer,
  tenant_bps integer,
  creator_bps integer,
  basis text CHECK (basis IN ('gross', 'net')),
  state text NOT NULL DEFAULT 'unvalued' CHECK (state IN ('unvalued', 'posted', 'sandbox')),
  ledger_id uuid REFERENCES content_revenue_ledger(id),
  refunded_minor bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, source_id) REFERENCES content_cash_sources(tenant_id, id),
  CHECK (point_start + points <= denominator),
  CHECK ((income_type = 'membership' AND drama_id IS NULL AND creator_id IS NULL AND content_scope = 'private')
    OR (income_type <> 'membership' AND drama_id IS NOT NULL)),
  CHECK ((headquarters_bps IS NULL AND tenant_bps IS NULL AND creator_bps IS NULL)
    OR (headquarters_bps BETWEEN 0 AND 10000 AND tenant_bps BETWEEN 0 AND 10000 AND creator_bps BETWEEN 0 AND 10000
      AND headquarters_bps + tenant_bps + creator_bps = 10000))
);
CREATE INDEX IF NOT EXISTS content_revenue_events_source ON content_revenue_events(tenant_id, source_id);
CREATE INDEX IF NOT EXISTS content_revenue_events_pending ON content_revenue_events(tenant_id, occurred_at) WHERE state = 'unvalued';
CREATE TABLE IF NOT EXISTS content_revenue_closures (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  currency text NOT NULL,
  settlement_month date NOT NULL,
  entry_count integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(tenant_id, currency, settlement_month)
);
CREATE TABLE IF NOT EXISTS content_cash_statements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL REFERENCES content_cash_sources(id),
  report_id text NOT NULL,
  row_id text NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  net_minor bigint NOT NULL CHECK (net_minor >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(tenant_id, report_id, row_id),
  UNIQUE(source_id)
);
CREATE TABLE IF NOT EXISTS content_ad_report_rows (
  id uuid PRIMARY KEY REFERENCES content_cash_sources(id),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  report_id text NOT NULL,
  row_id text NOT NULL,
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE(tenant_id, report_id, row_id)
);
DROP TRIGGER IF EXISTS cash_statements_immutable ON content_cash_statements;
CREATE TRIGGER cash_statements_immutable BEFORE UPDATE OR DELETE ON content_cash_statements FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();
DROP TRIGGER IF EXISTS ad_report_rows_immutable ON content_ad_report_rows;
CREATE TRIGGER ad_report_rows_immutable BEFORE UPDATE OR DELETE ON content_ad_report_rows FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

ALTER TABLE content_revenue_ledger ALTER COLUMN drama_id DROP NOT NULL;
ALTER TABLE content_revenue_ledger DROP CONSTRAINT IF EXISTS content_revenue_ledger_currency_check;
ALTER TABLE content_revenue_ledger ADD CONSTRAINT content_revenue_ledger_currency_check CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE content_revenue_ledger DROP CONSTRAINT IF EXISTS content_revenue_ledger_source_check;
ALTER TABLE content_revenue_ledger ADD CONSTRAINT content_revenue_ledger_source_check CHECK (
  source_type IN ('apple_transaction', 'google_transaction', 'coin_unlock', 'ad_revenue', 'cash_event', 'cash_refund')
  AND char_length(btrim(source_id)) BETWEEN 1 AND 500);
ALTER TABLE content_revenue_ledger DROP CONSTRAINT IF EXISTS content_revenue_ledger_amount_check;
ALTER TABLE content_revenue_ledger ADD CONSTRAINT content_revenue_ledger_amount_check CHECK (
  headquarters_minor + tenant_minor + creator_minor = gross_minor AND
  ((source_type <> 'cash_refund' AND gross_minor >= 0 AND headquarters_minor >= 0 AND tenant_minor >= 0 AND creator_minor >= 0)
    OR (source_type = 'cash_refund' AND gross_minor <= 0 AND headquarters_minor <= 0 AND tenant_minor <= 0 AND creator_minor <= 0)));
ALTER TABLE content_revenue_ledger DROP CONSTRAINT IF EXISTS content_revenue_ledger_reversal_check;
ALTER TABLE content_revenue_ledger ADD CONSTRAINT content_revenue_ledger_reversal_check CHECK (
  ((status = 'reversed' OR source_type = 'cash_refund') AND reversal_of_id IS NOT NULL)
    OR (status <> 'reversed' AND source_type <> 'cash_refund' AND reversal_of_id IS NULL));

CREATE OR REPLACE FUNCTION app.post_cash_event(event_id uuid, accept_missing_policy boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE e content_revenue_events%ROWTYPE; s content_cash_sources%ROWTYPE; p content_revenue_share_policies%ROWTYPE;
  original content_revenue_ledger%ROWTYPE; basis_amount bigint; total bigint; hq bigint; creator bigint;
  refund_total bigint; refund_hq bigint; refund_creator bigint; previous_hq bigint; previous_creator bigint;
  posting_time timestamptz; chosen_basis text; ledger_key uuid;
  recognized_cash bigint; refunded_consumption bigint;
BEGIN
  SELECT * INTO e FROM content_revenue_events WHERE id = event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM id FROM tenants WHERE id = e.tenant_id FOR SHARE;
  SELECT * INTO s FROM content_cash_sources WHERE id = e.source_id AND tenant_id = e.tenant_id FOR SHARE;
  IF s.sandbox THEN UPDATE content_revenue_events SET state = 'sandbox' WHERE id = e.id; RETURN; END IF;
  IF e.state = 'unvalued' THEN
    chosen_basis := e.basis;
    IF chosen_basis IS NULL THEN SELECT basis INTO chosen_basis FROM content_revenue_basis WHERE tenant_id = e.tenant_id; END IF;
    IF e.headquarters_bps IS NULL AND accept_missing_policy THEN
      SELECT * INTO p FROM content_revenue_share_policies WHERE tenant_id = e.tenant_id
        AND content_scope = e.content_scope AND income_type = e.income_type AND status = 'active' FOR SHARE;
      e.headquarters_bps := p.headquarters_bps; e.tenant_bps := p.tenant_bps; e.creator_bps := p.creator_bps;
    END IF;
    IF chosen_basis IS NULL OR e.headquarters_bps IS NULL OR (e.content_scope = 'public' AND e.creator_id IS NULL) THEN RETURN; END IF;
    basis_amount := CASE chosen_basis WHEN 'gross' THEN s.gross_minor ELSE s.net_minor END;
    IF basis_amount IS NULL THEN RETURN; END IF;
    total := floor(basis_amount::numeric * (e.point_start + e.points) / e.denominator)
      - floor(basis_amount::numeric * e.point_start / e.denominator);
    hq := floor(total::numeric * e.headquarters_bps / 10000);
    creator := floor(total::numeric * e.creator_bps / 10000);
    posting_time := e.occurred_at;
    -- Do not reopen a statement already settled; late facts enter the current adjustment period.
    IF EXISTS (SELECT 1 FROM content_revenue_ledger WHERE tenant_id = e.tenant_id AND currency = s.currency
      AND settlement_month = date_trunc('month', posting_time AT TIME ZONE 'UTC')::date AND status = 'settled')
      OR EXISTS (SELECT 1 FROM content_revenue_closures WHERE tenant_id = e.tenant_id AND currency = s.currency
        AND settlement_month = date_trunc('month', posting_time AT TIME ZONE 'UTC')::date)
    THEN posting_time := statement_timestamp(); END IF;
    ledger_key := gen_random_uuid();
    INSERT INTO content_revenue_ledger(id, tenant_id, drama_id, episode_id, creator_id_snapshot, content_scope, income_type,
      currency, gross_minor, headquarters_minor, tenant_minor, creator_minor, headquarters_bps_snapshot, tenant_bps_snapshot,
      creator_bps_snapshot, source_type, source_id, settlement_month, occurred_at)
    VALUES (ledger_key, e.tenant_id, e.drama_id, e.episode_id, e.creator_id, e.content_scope, e.income_type, s.currency,
      total, hq, total - hq - creator, creator, e.headquarters_bps, e.tenant_bps, e.creator_bps,
      'cash_event', e.id::text, date_trunc('month', posting_time AT TIME ZONE 'UTC')::date, posting_time);
    UPDATE content_revenue_events SET state = 'posted', ledger_id = ledger_key, basis = chosen_basis,
      headquarters_bps = e.headquarters_bps, tenant_bps = e.tenant_bps, creator_bps = e.creator_bps WHERE id = e.id;
    e.ledger_id := ledger_key;
  END IF;
  IF e.ledger_id IS NULL THEN RETURN; END IF;
  SELECT * INTO original FROM content_revenue_ledger WHERE id = e.ledger_id;
  -- Refunds remove unconsumed cash first. Only the excess claws back content revenue.
  -- Otherwise reclaiming unused coins AND prorating every later use would double-count the refund.
  SELECT coalesce(sum(floor(s.gross_minor::numeric * (point_start + points) / denominator)
      - floor(s.gross_minor::numeric * point_start / denominator)), 0)
    INTO recognized_cash FROM content_revenue_events WHERE source_id = s.id;
  refunded_consumption := greatest(0, recognized_cash - (s.gross_minor - s.refunded_minor));
  refund_total := CASE WHEN recognized_cash = 0 THEN 0
    ELSE floor(original.gross_minor::numeric * refunded_consumption / recognized_cash) END;
  IF refund_total <= e.refunded_minor THEN RETURN; END IF;
  refund_hq := CASE WHEN original.gross_minor = 0 THEN 0 ELSE floor(original.headquarters_minor::numeric * refund_total / original.gross_minor) END;
  -- Nested apportionment keeps each party's cumulative reversal monotonic, even at one-cent boundaries.
  refund_creator := CASE WHEN original.gross_minor = original.headquarters_minor THEN 0
    ELSE floor(original.creator_minor::numeric * (refund_total - refund_hq) / (original.gross_minor - original.headquarters_minor)) END;
  SELECT -coalesce(sum(headquarters_minor), 0), -coalesce(sum(creator_minor), 0) INTO previous_hq, previous_creator
    FROM content_revenue_ledger WHERE reversal_of_id = original.id AND source_type = 'cash_refund';
  INSERT INTO content_revenue_ledger(id, tenant_id, drama_id, episode_id, creator_id_snapshot, content_scope, income_type,
    currency, gross_minor, headquarters_minor, tenant_minor, creator_minor, headquarters_bps_snapshot, tenant_bps_snapshot,
    creator_bps_snapshot, source_type, source_id, settlement_month, occurred_at, reversal_of_id)
  VALUES (gen_random_uuid(), e.tenant_id, e.drama_id, e.episode_id, e.creator_id, e.content_scope, e.income_type, s.currency,
    -(refund_total - e.refunded_minor), -(refund_hq - previous_hq),
    -(refund_total - e.refunded_minor) + refund_hq - previous_hq + refund_creator - previous_creator,
    -(refund_creator - previous_creator), original.headquarters_bps_snapshot, original.tenant_bps_snapshot, original.creator_bps_snapshot,
    'cash_refund', e.id::text || ':' || refund_total::text, date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date,
    statement_timestamp(), original.id);
  UPDATE content_revenue_events SET refunded_minor = refund_total WHERE id = e.id;
END
$function$;

CREATE OR REPLACE FUNCTION app.snapshot_cash_event() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE p content_revenue_share_policies%ROWTYPE;
BEGIN
  SELECT * INTO p FROM content_revenue_share_policies WHERE tenant_id = NEW.tenant_id AND content_scope = NEW.content_scope
    AND income_type = NEW.income_type AND status = 'active' FOR SHARE;
  NEW.headquarters_bps := p.headquarters_bps; NEW.tenant_bps := p.tenant_bps; NEW.creator_bps := p.creator_bps;
  SELECT basis INTO NEW.basis FROM content_revenue_basis WHERE tenant_id = NEW.tenant_id;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS content_cash_event_snapshot ON content_revenue_events;
CREATE TRIGGER content_cash_event_snapshot BEFORE INSERT ON content_revenue_events FOR EACH ROW EXECUTE FUNCTION app.snapshot_cash_event();

CREATE OR REPLACE FUNCTION app.sync_cash_source(source_kind text, source_key uuid)
RETURNS void LANGUAGE plpgsql AS $function$
DECLARE n native_store_transactions%ROWTYPE; t payment_transactions%ROWTYPE; account_key uuid; sandbox_value boolean; e record;
BEGIN
  IF source_kind = 'native_store' THEN
    SELECT * INTO n FROM native_store_transactions WHERE id = source_key;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing verified store source'; END IF;
    INSERT INTO content_cash_sources(id, tenant_id, account_id, source_type, currency, gross_minor, net_minor, refunded_minor, sandbox, occurred_at)
    VALUES (n.id, n.tenant_id, n.account_id, source_kind, n.currency, n.gross_minor,
      CASE WHEN n.refunded_minor = 0 THEN n.net_minor ELSE NULL END, n.refunded_minor, n.environment = 'Sandbox', n.purchased_at)
    ON CONFLICT(id) DO UPDATE SET refunded_minor = greatest(content_cash_sources.refunded_minor, excluded.refunded_minor),
      net_minor = coalesce(content_cash_sources.net_minor, excluded.net_minor);
  ELSIF source_kind = 'payment' THEN
    SELECT * INTO t FROM payment_transactions WHERE id = source_key AND status = 'succeeded' AND transaction_type = 'charge';
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing verified payment source'; END IF;
    SELECT account_id INTO account_key FROM orders WHERE id = t.order_id;
    -- Legacy mock channels are test money, irrespective of the amounts in their callbacks.
    SELECT attempt.adapter_code_snapshot <> 'stripe' OR coalesce(config.provider_mode, 'test') <> 'live'
      INTO sandbox_value FROM payment_attempts attempt JOIN payment_configs config ON config.id = attempt.payment_config_id
      WHERE attempt.id = t.attempt_id;
    INSERT INTO content_cash_sources(id, tenant_id, account_id, source_type, currency, gross_minor, refunded_minor, sandbox, occurred_at)
    VALUES (t.id, t.tenant_id, account_key, source_kind, t.currency, t.amount_minor,
      coalesce((SELECT sum(amount_minor) FROM payment_refunds WHERE payment_transaction_id = t.id AND status IN ('succeeded', 'manual_reconciliation')), 0),
      sandbox_value, t.occurred_at)
    ON CONFLICT(id) DO UPDATE SET refunded_minor = greatest(content_cash_sources.refunded_minor, excluded.refunded_minor);
  ELSE RAISE EXCEPTION 'Invalid cash source'; END IF;
  FOR e IN SELECT id FROM content_revenue_events WHERE source_id = source_key ORDER BY id LOOP
    PERFORM app.post_cash_event(e.id);
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION app.record_point_cash(input_row point_ledger) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app AS $function$
DECLARE NEW point_ledger := input_row; paid_points bigint := 0; source_key uuid; lot point_cash_lots%ROWTYPE; use_row record;
  needed bigint; taken bigint; use_key uuid; unlock_row point_unlocks%ROWTYPE; drama_row dramas%ROWTYPE;
  phase integer; phases integer := 1; phase_paid bigint; related_event record;
BEGIN
  IF NEW.delta > 0 THEN
    IF NEW.entry_type = 'topup' AND NEW.reference_type IN ('native_store_transaction', 'payment_transaction') THEN
      source_key := NEW.reference_id;
      PERFORM app.sync_cash_source(CASE NEW.reference_type WHEN 'native_store_transaction' THEN 'native_store' ELSE 'payment' END, source_key);
      IF NEW.reference_type = 'native_store_transaction' THEN
        SELECT points_snapshot INTO paid_points FROM native_store_transactions WHERE id = source_key;
      ELSE
        SELECT (item.product_snapshot_json->>'pointsAmount')::bigint INTO paid_points
          FROM payment_transactions t JOIN order_items item ON item.order_id = t.order_id AND item.line_no = 1 WHERE t.id = source_key;
      END IF;
      INSERT INTO point_cash_lots(id, tenant_id, account_id, credit_id, source_id, denominator, points, remaining, created_at)
        VALUES (gen_random_uuid(), NEW.tenant_id, NEW.account_id, NEW.id, source_key, paid_points, paid_points, paid_points, NEW.created_at);
    ELSIF NEW.entry_type = 'refund_release' AND NEW.reference_type = 'payment_refund' THEN
      -- A failed refund returns the exact reserved ranges, not fresh gift credits.
      FOR use_row IN SELECT u.* FROM point_cash_uses u JOIN point_ledger debit ON debit.id = u.debit_id
        WHERE debit.tenant_id = NEW.tenant_id AND debit.reference_type = 'payment_refund'
          AND debit.reference_id = NEW.reference_id AND debit.entry_type = 'refund_reserve'
      LOOP
        INSERT INTO point_cash_lots(id, tenant_id, account_id, credit_id, source_id, is_cash, point_start, denominator, points, remaining, created_at)
        VALUES (gen_random_uuid(), NEW.tenant_id, NEW.account_id, NEW.id, use_row.source_id, use_row.is_cash, use_row.point_start,
          use_row.denominator, use_row.points, use_row.points, NEW.created_at);
        paid_points := paid_points + use_row.points;
      END LOOP;
      IF paid_points <> NEW.delta THEN RAISE EXCEPTION 'Refund release provenance mismatch'; END IF;
    END IF;
    IF NEW.delta > paid_points THEN
      INSERT INTO point_cash_lots(id, tenant_id, account_id, credit_id, source_id, is_cash, denominator, points, remaining, created_at)
      VALUES (gen_random_uuid(), NEW.tenant_id, NEW.account_id, NEW.id, source_key, false, NEW.delta - paid_points,
        NEW.delta - paid_points, NEW.delta - paid_points, NEW.created_at + interval '1 microsecond');
    END IF;
    RETURN;
  END IF;
  needed := -NEW.delta;
  phase_paid := needed;
  IF NEW.reference_type = 'native_store_refund' THEN
    phases := 2;
    phase_paid := (NEW.metadata_json->>'paidRefundPoints')::bigint;
    IF phase_paid IS NULL OR phase_paid < 0 OR phase_paid > needed THEN RAISE EXCEPTION 'Invalid refund credit allocation'; END IF;
  END IF;
  IF NEW.reference_type = 'point_unlock' THEN
    SELECT * INTO unlock_row FROM point_unlocks WHERE id = NEW.reference_id AND tenant_id = NEW.tenant_id;
    SELECT * INTO drama_row FROM dramas WHERE id = unlock_row.drama_id;
  END IF;
  FOR phase IN 1..phases LOOP
  needed := CASE WHEN phase = 1 THEN phase_paid ELSE -NEW.delta - phase_paid END;
  FOR lot IN SELECT * FROM point_cash_lots WHERE tenant_id = NEW.tenant_id AND account_id = NEW.account_id
    AND remaining > 0 ORDER BY
      CASE WHEN phases = 1 THEN 0 WHEN source_id = NEW.reference_id AND is_cash = (phase = 1) THEN 0
        WHEN source_id IS DISTINCT FROM NEW.reference_id THEN 1 ELSE 2 END, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN needed = 0;
    taken := least(needed, lot.remaining); use_key := gen_random_uuid();
    INSERT INTO point_cash_uses(id, tenant_id, account_id, debit_id, lot_id, source_id, is_cash, point_start, denominator, points)
      VALUES (use_key, NEW.tenant_id, NEW.account_id, NEW.id, lot.id, lot.source_id, lot.is_cash,
        lot.point_start + lot.points - lot.remaining, lot.denominator, taken);
    IF lot.source_id IS NOT NULL AND lot.is_cash AND unlock_row.id IS NOT NULL THEN
      INSERT INTO content_revenue_events(id, tenant_id, source_id, drama_id, episode_id, creator_id, content_scope, income_type,
        point_start, denominator, points, occurred_at)
      VALUES (use_key, NEW.tenant_id, lot.source_id, drama_row.id,
        CASE WHEN unlock_row.target_type = 'episode' THEN unlock_row.target_id ELSE NULL END,
        CASE WHEN drama_row.owner_type = 'platform' THEN drama_row.shanchuang_creator_id ELSE NULL END,
        CASE WHEN drama_row.owner_type = 'platform' THEN 'public' ELSE 'private' END, 'coin_unlock',
        lot.point_start + lot.points - lot.remaining, lot.denominator, taken, NEW.created_at);
      FOR related_event IN SELECT id FROM content_revenue_events WHERE source_id = lot.source_id ORDER BY id LOOP
        PERFORM app.post_cash_event(related_event.id);
      END LOOP;
    END IF;
    UPDATE point_cash_lots SET remaining = remaining - taken WHERE id = lot.id;
    needed := needed - taken;
  END LOOP;
  IF needed <> 0 THEN RAISE EXCEPTION 'Wallet provenance is incomplete; reconcile before spending'; END IF;
  END LOOP;
  RETURN;
END
$function$;

CREATE OR REPLACE FUNCTION app.track_point_cash() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app AS $function$
BEGIN
  PERFORM app.record_point_cash(NEW);
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS point_ledger_track_cash ON point_ledger;
CREATE TRIGGER point_ledger_track_cash AFTER INSERT ON point_ledger FOR EACH ROW EXECUTE FUNCTION app.track_point_cash();

CREATE OR REPLACE FUNCTION app.native_cash_changed() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  PERFORM app.sync_cash_source('native_store', NEW.id);
  IF NEW.kind = 'membership' AND NOT EXISTS (SELECT 1 FROM content_revenue_events WHERE id = NEW.id) THEN
    INSERT INTO content_revenue_events(id, tenant_id, source_id, content_scope, income_type, denominator, points, occurred_at)
      VALUES (NEW.id, NEW.tenant_id, NEW.id, 'private', 'membership', 1, 1, NEW.purchased_at);
    PERFORM app.post_cash_event(NEW.id);
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS native_store_cash_changed ON native_store_transactions;
CREATE TRIGGER native_store_cash_changed AFTER INSERT OR UPDATE ON native_store_transactions FOR EACH ROW EXECUTE FUNCTION app.native_cash_changed();
CREATE OR REPLACE FUNCTION app.legacy_cash_refunded() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('succeeded', 'manual_reconciliation') THEN PERFORM app.sync_cash_source('payment', NEW.payment_transaction_id); END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS payment_refunds_cash_changed ON payment_refunds;
CREATE TRIGGER payment_refunds_cash_changed AFTER INSERT OR UPDATE ON payment_refunds FOR EACH ROW EXECUTE FUNCTION app.legacy_cash_refunded();

CREATE OR REPLACE FUNCTION app.legacy_entitlement_cash() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE source_key uuid; drama_row dramas%ROWTYPE; drama_key uuid; episode_key uuid;
BEGIN
  IF NEW.source_type <> 'order' THEN RETURN NEW; END IF;
  SELECT id INTO source_key FROM payment_transactions WHERE order_id = NEW.source_order_id AND tenant_id = NEW.tenant_id
    AND transaction_type = 'charge' AND status = 'succeeded';
  IF source_key IS NULL THEN RETURN NEW; END IF;
  PERFORM app.sync_cash_source('payment', source_key);
  IF NEW.entitlement_type = 'episode' THEN
    episode_key := NEW.product_id; SELECT drama_id INTO drama_key FROM episodes WHERE id = NEW.product_id;
  ELSIF NEW.entitlement_type = 'drama' THEN drama_key := NEW.product_id;
  END IF;
  IF drama_key IS NOT NULL THEN SELECT * INTO drama_row FROM dramas WHERE id = drama_key; END IF;
  INSERT INTO content_revenue_events(id, tenant_id, source_id, drama_id, episode_id, creator_id, content_scope, income_type,
    denominator, points, occurred_at)
  VALUES (NEW.id, NEW.tenant_id, source_key, drama_key, episode_key,
    CASE WHEN drama_row.owner_type = 'platform' THEN drama_row.shanchuang_creator_id ELSE NULL END,
    CASE WHEN drama_row.owner_type = 'platform' THEN 'public' ELSE 'private' END,
    CASE WHEN NEW.entitlement_type = 'membership' THEN 'membership' ELSE 'coin_unlock' END, 1, 1, NEW.starts_at);
  PERFORM app.post_cash_event(NEW.id);
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS entitlements_track_cash ON entitlements;
CREATE TRIGGER entitlements_track_cash AFTER INSERT ON entitlements FOR EACH ROW EXECUTE FUNCTION app.legacy_entitlement_cash();

-- Do not silently label pre-migration balances as paid. Block settlement until they are reviewed.
CREATE TABLE IF NOT EXISTS content_revenue_legacy_review (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE content_revenue_legacy_review ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE content_revenue_legacy_review ADD COLUMN IF NOT EXISTS resolved_by uuid;
ALTER TABLE content_revenue_legacy_review ADD COLUMN IF NOT EXISTS report_id text;
ALTER TABLE content_revenue_legacy_review ADD COLUMN IF NOT EXISTS report_sha256 text;
INSERT INTO content_revenue_legacy_review(tenant_id, reason)
  SELECT DISTINCT tenant_id, 'Pre-migration wallet/order history needs a cash-provenance reconciliation'
  FROM point_ledger WHERE delta > 0 AND entry_type = 'topup'
    AND reference_type IN ('payment_transaction', 'native_store_transaction')
    AND NOT EXISTS (SELECT 1 FROM point_cash_lots WHERE credit_id = point_ledger.id)
  ON CONFLICT DO NOTHING;

INSERT INTO content_revenue_legacy_review(tenant_id, reason)
  SELECT DISTINCT tenant_id, 'Pre-migration direct-order entitlements need headquarters historical reconciliation'
    FROM entitlements WHERE source_type = 'order' AND NOT EXISTS (SELECT 1 FROM content_revenue_events WHERE id = entitlements.id)
  ON CONFLICT DO NOTHING;

-- Reconstruct known sources from immutable historical credits/debits, without changing wallets.
-- Never manufacture cash for a manual credit or silently erase an unexplained balance.
-- A malformed history aborts the migration transaction; the previous application remains deployable.
DO $replay$
DECLARE entry point_ledger%ROWTYPE;
BEGIN
  FOR entry IN SELECT p.* FROM point_ledger p
    WHERE (p.delta > 0 AND NOT EXISTS (SELECT 1 FROM point_cash_lots WHERE credit_id = p.id))
      OR (p.delta < 0 AND NOT EXISTS (SELECT 1 FROM point_cash_uses WHERE debit_id = p.id))
    ORDER BY p.tenant_id, p.account_id, p.created_at, p.id
  LOOP
    PERFORM app.record_point_cash(entry);
  END LOOP;
  IF EXISTS (SELECT 1 FROM point_accounts a WHERE a.balance <> coalesce(
    (SELECT sum(l.remaining) FROM point_cash_lots l WHERE l.tenant_id = a.tenant_id AND l.account_id = a.account_id), 0)) THEN
    RAISE EXCEPTION 'Historical wallet balances do not match immutable ledger provenance; migration rolled back';
  END IF;
END
$replay$;

DO $rls$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['content_revenue_basis', 'content_cash_sources', 'point_cash_lots', 'point_cash_uses',
    'content_revenue_events', 'content_revenue_legacy_review', 'content_revenue_closures', 'content_cash_statements', 'content_ad_report_rows'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS cash_tenant_read ON %I', target);
    EXECUTE format('CREATE POLICY cash_tenant_read ON %I FOR SELECT USING (tenant_id = app.current_tenant_id())', target);
    EXECUTE format('DROP POLICY IF EXISTS cash_platform_write ON %I', target);
    EXECUTE format('CREATE POLICY cash_platform_write ON %I FOR ALL USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user))', target);
  END LOOP;
END
$rls$;
REVOKE ALL ON FUNCTION app.record_point_cash(point_ledger), app.post_cash_event(uuid, boolean), app.snapshot_cash_event(), app.sync_cash_source(text, uuid),
  app.track_point_cash(), app.native_cash_changed(), app.legacy_cash_refunded(), app.legacy_entitlement_cash() FROM PUBLIC;
-- Invoker functions remain subject to RLS. Trigger bodies cannot be called as ordinary functions.
GRANT EXECUTE ON FUNCTION app.post_cash_event(uuid, boolean), app.sync_cash_source(text, uuid) TO PUBLIC;
COMMIT;
