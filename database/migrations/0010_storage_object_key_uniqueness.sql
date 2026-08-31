BEGIN;

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM media_assets
    WHERE storage_provider_id IS NOT NULL
      AND object_key IS NOT NULL
    GROUP BY storage_provider_id, object_key
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce storage object-key uniqueness while duplicate provider keys exist';
  END IF;
END
$block$;

CREATE UNIQUE INDEX IF NOT EXISTS media_assets_provider_object_key_unique_idx
  ON media_assets (storage_provider_id, object_key)
  WHERE storage_provider_id IS NOT NULL AND object_key IS NOT NULL;

COMMIT;
