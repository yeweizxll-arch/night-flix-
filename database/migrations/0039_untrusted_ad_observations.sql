BEGIN;
-- Diagnostic ILRD only. Never a payment, rewarded entitlement or creator-settlement source.
CREATE TABLE IF NOT EXISTS ad_paid_observations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_id text NOT NULL CHECK (event_id ~ '^[A-Za-z0-9_-]{16,100}$'),
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  format text NOT NULL CHECK (format IN ('rewardedEpisode', 'interstitial', 'appOpen', 'native')),
  ad_unit_id text NOT NULL,
  drama_id uuid REFERENCES dramas(id),
  episode_id uuid REFERENCES episodes(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  value_micros bigint NOT NULL CHECK (value_micros BETWEEN 0 AND 9000000000000000),
  precision_type text NOT NULL CHECK (char_length(precision_type) BETWEEN 1 AND 30),
  trust_level text NOT NULL DEFAULT 'client_unverified' CHECK (trust_level = 'client_unverified'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(tenant_id, event_id)
);
CREATE INDEX IF NOT EXISTS ad_paid_observations_retention ON ad_paid_observations(tenant_id, created_at);
ALTER TABLE ad_paid_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_paid_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_observation_tenant_read ON ad_paid_observations;
CREATE POLICY ad_observation_tenant_read ON ad_paid_observations FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS ad_observation_platform ON ad_paid_observations;
CREATE POLICY ad_observation_platform ON ad_paid_observations FOR ALL USING(app.has_platform_access(current_user)) WITH CHECK(app.has_platform_access(current_user));
COMMIT;
