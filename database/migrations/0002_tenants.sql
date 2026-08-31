BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  code citext NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  default_locale text NOT NULL DEFAULT 'zh-CN',
  timezone text NOT NULL DEFAULT 'UTC',
  default_currency varchar(3) NOT NULL DEFAULT 'USD',
  user_site_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT tenants_code_unique UNIQUE (code),
  CONSTRAINT tenants_code_format_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'
  ),
  CONSTRAINT tenants_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT tenants_status_check CHECK (status IN ('active', 'suspended', 'expired')),
  CONSTRAINT tenants_locale_check CHECK (
    default_locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT tenants_timezone_check CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 100),
  CONSTRAINT tenants_currency_check CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT tenants_version_check CHECK (version >= 0),
  CONSTRAINT tenants_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tenants_status_expires_at_idx
  ON tenants (status, expires_at);

DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;
CREATE TRIGGER tenants_set_updated_at
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS tenant_domains (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  host citext NOT NULL,
  type text NOT NULL,
  verification_token text NOT NULL,
  verified_at timestamptz,
  tls_status text NOT NULL DEFAULT 'pending',
  is_primary boolean NOT NULL DEFAULT false,
  disabled_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT tenant_domains_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_domains_host_unique UNIQUE (host),
  CONSTRAINT tenant_domains_host_format_check CHECK (
    host::text = lower(host::text)
    AND char_length(host::text) BETWEEN 1 AND 253
    AND host::text !~ '[:/[:space:]]'
    AND host::text ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  CONSTRAINT tenant_domains_type_check CHECK (type IN ('subdomain', 'custom')),
  CONSTRAINT tenant_domains_token_check CHECK (char_length(verification_token) BETWEEN 16 AND 512),
  CONSTRAINT tenant_domains_tls_status_check CHECK (
    tls_status IN ('pending', 'provisioning', 'active', 'failed', 'disabled')
  ),
  CONSTRAINT tenant_domains_primary_verified_check CHECK (NOT is_primary OR verified_at IS NOT NULL),
  CONSTRAINT tenant_domains_disabled_primary_check CHECK (disabled_at IS NULL OR NOT is_primary),
  CONSTRAINT tenant_domains_version_check CHECK (version >= 0),
  CONSTRAINT tenant_domains_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT tenant_domains_verified_timestamp_check CHECK (
    verified_at IS NULL OR verified_at >= created_at
  ),
  CONSTRAINT tenant_domains_disabled_timestamp_check CHECK (
    disabled_at IS NULL OR disabled_at >= created_at
  ),
  CONSTRAINT tenant_domains_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_one_primary_per_tenant_idx
  ON tenant_domains (tenant_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS tenant_domains_tenant_type_idx
  ON tenant_domains (tenant_id, type, disabled_at);

CREATE INDEX IF NOT EXISTS tenant_domains_resolution_idx
  ON tenant_domains (host)
  WHERE verified_at IS NOT NULL AND disabled_at IS NULL;

DROP TRIGGER IF EXISTS tenant_domains_set_updated_at ON tenant_domains;
CREATE TRIGGER tenant_domains_set_updated_at
BEFORE UPDATE ON tenant_domains
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.resolve_tenant_by_host(requested_host text)
RETURNS TABLE (id uuid, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT
    tenant.id,
    CASE
      WHEN tenant.status = 'active' AND tenant.expires_at <= statement_timestamp()
        THEN 'expired'
      ELSE tenant.status
    END AS status
  FROM public.tenant_domains AS domain
  INNER JOIN public.tenants AS tenant ON tenant.id = domain.tenant_id
  WHERE domain.host::text = regexp_replace(
    regexp_replace(
      regexp_replace(lower(btrim(requested_host)), '\.$', ''),
      ':[0-9]+$',
      ''
    ),
    '\.$',
    ''
  )
    AND domain.verified_at IS NOT NULL
    AND domain.disabled_at IS NULL
  LIMIT 1
$function$;

COMMENT ON FUNCTION app.resolve_tenant_by_host(text) IS
  'Resolves one verified, enabled host to the minimal tenant context before tenant RLS is established.';

REVOKE ALL ON FUNCTION app.resolve_tenant_by_host(text) FROM PUBLIC;

COMMIT;
