BEGIN;

-- Range scans used by the first operational analytics API. These remain raw
-- fact-table indexes; no pre-aggregated or synthetic presence data is stored.
CREATE INDEX IF NOT EXISTS customer_accounts_analytics_tenant_created_idx
  ON customer_accounts (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS customer_accounts_analytics_platform_created_idx
  ON customer_accounts (created_at, tenant_id, id);

CREATE INDEX IF NOT EXISTS orders_analytics_tenant_paid_idx
  ON orders (tenant_id, paid_at, currency, id)
  WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_analytics_platform_paid_idx
  ON orders (paid_at, currency, tenant_id, id)
  WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_analytics_tenant_refunded_idx
  ON orders (tenant_id, refunded_at, currency, id)
  WHERE refunded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_analytics_platform_refunded_idx
  ON orders (refunded_at, currency, tenant_id, id)
  WHERE refunded_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_refunds_analytics_tenant_succeeded_idx
  ON payment_refunds (tenant_id, succeeded_at, currency, id)
  WHERE status IN ('succeeded', 'manual_reconciliation');
CREATE INDEX IF NOT EXISTS payment_refunds_analytics_platform_succeeded_idx
  ON payment_refunds (succeeded_at, currency, tenant_id, id)
  WHERE status IN ('succeeded', 'manual_reconciliation');
CREATE INDEX IF NOT EXISTS payment_refunds_analytics_backlog_idx
  ON payment_refunds (tenant_id, status, created_at, id)
  WHERE status IN ('processing', 'manual_reconciliation');
CREATE INDEX IF NOT EXISTS payment_refunds_analytics_platform_backlog_idx
  ON payment_refunds (status, created_at, tenant_id, id)
  WHERE status IN ('processing', 'manual_reconciliation');

CREATE INDEX IF NOT EXISTS dramas_analytics_status_idx
  ON dramas (owner_type, owner_tenant_id, status, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS withdrawals_analytics_status_idx
  ON withdrawals (tenant_id, status, currency, id);

COMMIT;
