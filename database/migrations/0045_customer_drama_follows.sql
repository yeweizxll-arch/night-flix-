BEGIN;
CREATE TABLE IF NOT EXISTS customer_drama_follows (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  drama_id uuid NOT NULL REFERENCES dramas(id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, account_id, drama_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
ALTER TABLE customer_drama_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_drama_follows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_drama_follows_tenant ON customer_drama_follows;
CREATE POLICY customer_drama_follows_tenant ON customer_drama_follows FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_drama_follows_erasure ON customer_drama_follows;
CREATE POLICY customer_drama_follows_erasure ON customer_drama_follows FOR ALL
  USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user));
COMMIT;
