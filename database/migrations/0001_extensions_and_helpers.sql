BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
REVOKE CREATE ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO PUBLIC;

CREATE TABLE IF NOT EXISTS app.database_access_principals (
  role_name name PRIMARY KEY,
  access_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT database_access_principals_scope_check CHECK (access_scope = 'platform')
);

REVOKE ALL ON TABLE app.database_access_principals FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$function$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Returns the tenant UUID set with SET LOCAL app.tenant_id for the current transaction; NULL when unset.';

CREATE OR REPLACE FUNCTION app.has_platform_access(requesting_role name)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM app.database_access_principals
    WHERE role_name = requesting_role
      AND access_scope = 'platform'
  )
$function$;

COMMENT ON FUNCTION app.has_platform_access(name) IS
  'Checks whether the effective database role was explicitly registered for platform RLS access.';

CREATE OR REPLACE FUNCTION app.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION app.set_updated_at() IS
  'Maintains updated_at on mutable rows. Optimistic-lock version increments remain an explicit application update.';

CREATE OR REPLACE FUNCTION app.prevent_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END
$function$;

COMMENT ON FUNCTION app.prevent_row_mutation() IS
  'Rejects UPDATE and DELETE for append-only history and audit tables.';

REVOKE ALL ON FUNCTION app.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_row_mutation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.has_platform_access(name) TO PUBLIC;

COMMIT;
