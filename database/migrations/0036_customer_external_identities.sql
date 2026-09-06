CREATE TABLE IF NOT EXISTS customer_identity_challenges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX IF NOT EXISTS customer_identity_challenges_expiry ON customer_identity_challenges(expires_at);
CREATE TABLE IF NOT EXISTS customer_external_identities (
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, provider, subject),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
ALTER TABLE customer_identity_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identity_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_challenge_platform ON customer_identity_challenges;
CREATE POLICY identity_challenge_platform ON customer_identity_challenges FOR ALL
  USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user));
ALTER TABLE customer_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_external_identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_identity_platform ON customer_external_identities;
CREATE POLICY external_identity_platform ON customer_external_identities FOR ALL
  USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user));
DROP POLICY IF EXISTS external_identity_tenant_read ON customer_external_identities;
CREATE POLICY external_identity_tenant_read ON customer_external_identities FOR SELECT
  USING (tenant_id = app.current_tenant_id());
