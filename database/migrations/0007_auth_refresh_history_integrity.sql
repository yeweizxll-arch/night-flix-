BEGIN;

ALTER TABLE auth_refresh_token_history
  DROP CONSTRAINT IF EXISTS auth_refresh_history_family_id_check;
ALTER TABLE auth_refresh_token_history
  ADD CONSTRAINT auth_refresh_history_family_id_check CHECK (
    session_family_id <> '00000000-0000-0000-0000-000000000000'::uuid
  );

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth_refresh_token_history AS history
    LEFT JOIN auth_sessions AS session ON session.id = history.session_id
    WHERE session.id IS NULL
      OR history.session_family_id IS DISTINCT FROM session.session_family_id
      OR history.tenant_id IS DISTINCT FROM session.tenant_id
      OR history.subject_type IS DISTINCT FROM session.subject_type
      OR history.subject_id IS DISTINCT FROM session.subject_id
      OR history.expires_at IS DISTINCT FROM session.absolute_expires_at
      OR history.used_at < session.issued_at
  ) THEN
    RAISE EXCEPTION 'Existing refresh token history does not match its session identity'
      USING ERRCODE = '23514';
  END IF;
END
$block$;

CREATE OR REPLACE FUNCTION app.enforce_refresh_history_session_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  expected_family_id uuid;
  expected_tenant_id uuid;
  expected_subject_type text;
  expected_subject_id uuid;
  expected_issued_at timestamptz;
  expected_absolute_expires_at timestamptz;
BEGIN
  SELECT
    session_family_id,
    tenant_id,
    subject_type,
    subject_id,
    issued_at,
    absolute_expires_at
  INTO
    expected_family_id,
    expected_tenant_id,
    expected_subject_type,
    expected_subject_id,
    expected_issued_at,
    expected_absolute_expires_at
  FROM public.auth_sessions
  WHERE id = NEW.session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refresh token history session % does not exist', NEW.session_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.session_family_id IS DISTINCT FROM expected_family_id
    OR NEW.tenant_id IS DISTINCT FROM expected_tenant_id
    OR NEW.subject_type IS DISTINCT FROM expected_subject_type
    OR NEW.subject_id IS DISTINCT FROM expected_subject_id
    OR NEW.expires_at IS DISTINCT FROM expected_absolute_expires_at
    OR NEW.used_at < expected_issued_at THEN
    RAISE EXCEPTION 'Refresh token history identity must match its session'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.enforce_refresh_history_session_identity() FROM PUBLIC;

DROP TRIGGER IF EXISTS auth_refresh_history_enforce_session_identity
  ON auth_refresh_token_history;
CREATE TRIGGER auth_refresh_history_enforce_session_identity
BEFORE INSERT OR UPDATE OF
  session_id,
  session_family_id,
  tenant_id,
  subject_type,
  subject_id,
  used_at,
  expires_at
ON auth_refresh_token_history
FOR EACH ROW EXECUTE FUNCTION app.enforce_refresh_history_session_identity();

COMMIT;
