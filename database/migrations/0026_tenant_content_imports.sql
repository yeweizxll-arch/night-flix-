BEGIN;

ALTER TABLE content_import_jobs
  ALTER COLUMN file_id DROP NOT NULL;

ALTER TABLE content_import_jobs
  ADD COLUMN IF NOT EXISTS inline_payload_hash text,
  ADD COLUMN IF NOT EXISTS requested_rows integer,
  ADD COLUMN IF NOT EXISTS payload_bytes integer;

ALTER TABLE content_import_jobs
  DROP CONSTRAINT IF EXISTS content_import_jobs_format_check,
  DROP CONSTRAINT IF EXISTS content_import_jobs_source_check,
  DROP CONSTRAINT IF EXISTS content_import_jobs_inline_hash_check,
  DROP CONSTRAINT IF EXISTS content_import_jobs_requested_rows_check,
  DROP CONSTRAINT IF EXISTS content_import_jobs_payload_bytes_check;

ALTER TABLE content_import_jobs
  ADD CONSTRAINT content_import_jobs_format_check
    CHECK (format IN ('csv', 'json', 'xlsx')),
  ADD CONSTRAINT content_import_jobs_source_check CHECK (
    (file_id IS NOT NULL AND inline_payload_hash IS NULL
      AND requested_rows IS NULL AND payload_bytes IS NULL)
    OR
    (file_id IS NULL AND inline_payload_hash IS NOT NULL
      AND requested_rows IS NOT NULL AND payload_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT content_import_jobs_inline_hash_check CHECK (
    inline_payload_hash IS NULL OR inline_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT content_import_jobs_requested_rows_check CHECK (
    requested_rows IS NULL OR requested_rows BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT content_import_jobs_payload_bytes_check CHECK (
    payload_bytes IS NULL OR payload_bytes BETWEEN 2 AND 1048576
  );

ALTER TABLE content_import_rows
  DROP CONSTRAINT IF EXISTS content_import_rows_number_check;
ALTER TABLE content_import_rows
  ADD CONSTRAINT content_import_rows_number_check CHECK (row_number BETWEEN 1 AND 200);

CREATE INDEX IF NOT EXISTS content_import_jobs_worker_idx
  ON content_import_jobs (status, created_at, id)
  WHERE status = 'uploaded';

CREATE OR REPLACE FUNCTION app.enforce_import_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  file_owner_type text;
  file_owner_tenant uuid;
BEGIN
  IF NEW.file_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT owner_type, owner_tenant_id INTO file_owner_type, file_owner_tenant
  FROM media_assets WHERE id = NEW.file_id;

  IF file_owner_type IS DISTINCT FROM 'tenant'
    OR file_owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Import file must belong to the importing tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION app.enforce_import_scope() FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.enforce_import_row_result()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_owner_type text;
  target_tenant_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'imported' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.row_number IS DISTINCT FROM OLD.row_number
    OR NEW.imported_drama_id IS DISTINCT FROM OLD.imported_drama_id
  ) THEN
    RAISE EXCEPTION 'Imported content row result is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'imported' THEN
    SELECT owner_type, owner_tenant_id
      INTO target_owner_type, target_tenant_id
    FROM dramas WHERE id = NEW.imported_drama_id;

    IF target_owner_type IS DISTINCT FROM 'tenant'
      OR target_tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Imported drama must belong to the import tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS content_import_rows_enforce_result ON content_import_rows;
CREATE TRIGGER content_import_rows_enforce_result
BEFORE INSERT OR UPDATE ON content_import_rows
FOR EACH ROW EXECUTE FUNCTION app.enforce_import_row_result();

REVOKE ALL ON FUNCTION app.enforce_import_row_result() FROM PUBLIC;

COMMIT;
