BEGIN;
CREATE TABLE IF NOT EXISTS tenant_drama_discovery (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  drama_id uuid NOT NULL REFERENCES dramas(id),
  weight integer NOT NULL DEFAULT 0 CHECK (weight BETWEEN -100000 AND 100000),
  pinned_rank integer NOT NULL DEFAULT 0 CHECK (pinned_rank BETWEEN 0 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, drama_id)
);
ALTER TABLE tenant_drama_discovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_drama_discovery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_drama_discovery_tenant ON tenant_drama_discovery;
CREATE POLICY tenant_drama_discovery_tenant ON tenant_drama_discovery FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
COMMIT;
