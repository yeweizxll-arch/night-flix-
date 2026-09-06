BEGIN;
ALTER TABLE dramas ADD COLUMN IF NOT EXISTS first_published_at timestamptz;
-- Historical rows have no publication timestamp; retain their previous ordering.
UPDATE dramas SET first_published_at = coalesce(release_at, created_at)
  WHERE status = 'published' AND first_published_at IS NULL;
CREATE OR REPLACE FUNCTION app.record_drama_first_publication()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.first_published_at := CASE WHEN NEW.status = 'published'
      THEN coalesce(NEW.release_at, statement_timestamp()) ELSE NULL END;
  ELSIF OLD.first_published_at IS NOT NULL THEN
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.status = 'published' AND OLD.status <> 'published' THEN
    NEW.first_published_at := statement_timestamp();
  END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS dramas_first_publication ON dramas;
CREATE TRIGGER dramas_first_publication BEFORE INSERT OR UPDATE ON dramas
  FOR EACH ROW EXECUTE FUNCTION app.record_drama_first_publication();
COMMIT;
