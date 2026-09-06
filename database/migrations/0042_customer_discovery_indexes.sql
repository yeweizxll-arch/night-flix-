BEGIN;
-- Tenant-leading indexes support popularity aggregation without cross-tenant scans.
CREATE INDEX IF NOT EXISTS watch_progress_discovery_idx
  ON watch_progress (tenant_id, drama_id, account_id, updated_at DESC)
  WHERE position_seconds >= 10 OR completed;
CREATE INDEX IF NOT EXISTS customer_favorites_discovery_idx
  ON customer_favorites (tenant_id, drama_id, created_at DESC);
CREATE INDEX IF NOT EXISTS interaction_comments_discovery_idx
  ON interaction_comments (tenant_id, drama_id, account_id, created_at DESC)
  WHERE status = 'visible';
COMMIT;
