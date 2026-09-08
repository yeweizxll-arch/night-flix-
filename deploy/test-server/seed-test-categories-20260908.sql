-- NightFlix test catalog only. Take a verified pg_dump before running.
-- This changes metadata of the 90 synthetic scv2 shows, never media or rights.
\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('nightflix-test-categories-20260908'));
CREATE TEMP TABLE category_targets ON COMMIT DROP AS
SELECT d.id, d.version, d.category_id,
  CASE
    WHEN t.title ~ '校园爱情|爱不该被消磨|重生告白' THEN 'romance'
    WHEN t.title ~ '古风伤感' THEN 'historical'
    WHEN t.title ~ '玄幻|狐仙|天外仙|云海仙宫' THEN 'fantasy'
    WHEN t.title ~ '废土近未来战争' THEN 'scifi'
    ELSE 'drama'
  END AS category_code
FROM dramas d JOIN drama_translations t ON t.drama_id = d.id AND t.locale = 'zh-CN'
WHERE d.owner_type = 'tenant' AND d.owner_tenant_id = '01a076ee-40c2-7cfe-8fc9-ce03682a286e'
  AND d.code::text ~ '^scv2-show-(0?[1-9]|[1-8][0-9]|90)$'
  AND d.status = 'published' AND d.deleted_at IS NULL;
DO $$ BEGIN
  IF (SELECT count(*) FROM category_targets) <> 90
    OR EXISTS (SELECT 1 FROM category_targets WHERE category_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM categories WHERE owner_tenant_id = '01a076ee-40c2-7cfe-8fc9-ce03682a286e')
  THEN RAISE EXCEPTION 'Test catalog baseline changed; stop and inspect'; END IF;
END $$;
SELECT d.id FROM dramas d JOIN category_targets t ON t.id = d.id FOR UPDATE OF d;
INSERT INTO categories (id, owner_type, owner_tenant_id, code, sort_order)
SELECT gen_random_uuid(), 'tenant', '01a076ee-40c2-7cfe-8fc9-ce03682a286e', code, rank
FROM (VALUES ('romance', 1), ('historical', 2), ('fantasy', 3), ('scifi', 4), ('drama', 5)) AS names(code, rank);
INSERT INTO category_translations (id, category_id, locale, name)
SELECT gen_random_uuid(), c.id, tr.locale, tr.name
FROM categories c JOIN (VALUES
  ('romance','zh-CN','爱情'), ('romance','en-US','Romance'),
  ('historical','zh-CN','古装'), ('historical','en-US','Historical'),
  ('fantasy','zh-CN','玄幻'), ('fantasy','en-US','Fantasy'),
  ('scifi','zh-CN','科幻'), ('scifi','en-US','Sci-Fi'),
  ('drama','zh-CN','剧情'), ('drama','en-US','Drama')
) AS tr(code, locale, name) ON tr.code = c.code
WHERE c.owner_tenant_id = '01a076ee-40c2-7cfe-8fc9-ce03682a286e';
DO $$ DECLARE changed integer; BEGIN
  UPDATE dramas d SET category_id = c.id, version = d.version + 1
  FROM category_targets t JOIN categories c ON c.code = t.category_code
    AND c.owner_tenant_id = '01a076ee-40c2-7cfe-8fc9-ce03682a286e'
  WHERE d.id = t.id AND d.version = t.version AND d.category_id IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 90 THEN RAISE EXCEPTION 'Concurrent change: expected 90, got %', changed; END IF;
END $$;
SELECT category_code, count(*) FROM category_targets GROUP BY category_code ORDER BY category_code;
COMMIT;
