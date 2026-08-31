BEGIN;

CREATE OR REPLACE FUNCTION app.tenant_has_drama_license(requested_drama_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT app.current_tenant_id() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.content_license_items AS item
      INNER JOIN public.content_licenses AS license
        ON license.id = item.license_id
       AND license.tenant_id = item.tenant_id
      WHERE item.tenant_id = app.current_tenant_id()
        AND item.drama_id = requested_drama_id
        AND license.status IN ('scheduled', 'active')
        AND license.starts_at <= statement_timestamp()
        AND license.expires_at > statement_timestamp()
    )
$function$;

COMMENT ON FUNCTION app.tenant_has_drama_license(uuid) IS
  'Checks the current trusted tenant context against active license snapshot items.';

CREATE OR REPLACE FUNCTION app.tenant_can_access_media(requested_asset_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT app.current_tenant_id() IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM public.dramas AS drama
        WHERE drama.owner_type = 'platform'
          AND drama.cover_file_id = requested_asset_id
          AND app.tenant_has_drama_license(drama.id)
      )
      OR EXISTS (
        SELECT 1
        FROM public.episodes AS episode
        INNER JOIN public.dramas AS drama ON drama.id = episode.drama_id
        WHERE drama.owner_type = 'platform'
          AND episode.media_asset_id = requested_asset_id
          AND app.tenant_has_drama_license(drama.id)
      )
    )
$function$;

COMMENT ON FUNCTION app.tenant_can_access_media(uuid) IS
  'Allows platform media reads only when the media belongs to a drama licensed to the current tenant.';

GRANT EXECUTE ON FUNCTION app.tenant_has_drama_license(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_can_access_media(uuid) TO PUBLIC;

ALTER TABLE storage_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS storage_providers_tenant_select ON storage_providers;
CREATE POLICY storage_providers_tenant_select ON storage_providers
  FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND status = 'active')
  );
DROP POLICY IF EXISTS storage_providers_tenant_insert ON storage_providers;
CREATE POLICY storage_providers_tenant_insert ON storage_providers
  FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS storage_providers_tenant_update ON storage_providers;
CREATE POLICY storage_providers_tenant_update ON storage_providers
  FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS storage_providers_tenant_delete ON storage_providers;
CREATE POLICY storage_providers_tenant_delete ON storage_providers
  FOR DELETE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS storage_providers_platform_access ON storage_providers;
CREATE POLICY storage_providers_platform_access ON storage_providers
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS media_assets_tenant_select ON media_assets;
CREATE POLICY media_assets_tenant_select ON media_assets
  FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND app.tenant_can_access_media(id))
  );
DROP POLICY IF EXISTS media_assets_tenant_insert ON media_assets;
CREATE POLICY media_assets_tenant_insert ON media_assets
  FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS media_assets_tenant_update ON media_assets;
CREATE POLICY media_assets_tenant_update ON media_assets
  FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS media_assets_tenant_delete ON media_assets;
CREATE POLICY media_assets_tenant_delete ON media_assets
  FOR DELETE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS media_assets_platform_access ON media_assets;
CREATE POLICY media_assets_platform_access ON media_assets
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS categories_tenant_select ON categories;
CREATE POLICY categories_tenant_select ON categories
  FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND status = 'active' AND deleted_at IS NULL)
  );
DROP POLICY IF EXISTS categories_tenant_insert ON categories;
CREATE POLICY categories_tenant_insert ON categories
  FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS categories_tenant_update ON categories;
CREATE POLICY categories_tenant_update ON categories
  FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS categories_tenant_delete ON categories;
CREATE POLICY categories_tenant_delete ON categories
  FOR DELETE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS categories_platform_access ON categories;
CREATE POLICY categories_platform_access ON categories
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE category_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS category_translations_tenant_select ON category_translations;
CREATE POLICY category_translations_tenant_select ON category_translations
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM categories WHERE categories.id = category_id));
DROP POLICY IF EXISTS category_translations_tenant_insert ON category_translations;
CREATE POLICY category_translations_tenant_insert ON category_translations
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM categories
    WHERE categories.id = category_id
      AND categories.owner_type = 'tenant'
      AND categories.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS category_translations_tenant_update ON category_translations;
CREATE POLICY category_translations_tenant_update ON category_translations
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM categories
    WHERE categories.id = category_id
      AND categories.owner_type = 'tenant'
      AND categories.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM categories
    WHERE categories.id = category_id
      AND categories.owner_type = 'tenant'
      AND categories.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS category_translations_tenant_delete ON category_translations;
CREATE POLICY category_translations_tenant_delete ON category_translations
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM categories
    WHERE categories.id = category_id
      AND categories.owner_type = 'tenant'
      AND categories.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS category_translations_platform_access ON category_translations;
CREATE POLICY category_translations_platform_access ON category_translations
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tags_tenant_select ON tags;
CREATE POLICY tags_tenant_select ON tags
  FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND status = 'active' AND deleted_at IS NULL)
  );
DROP POLICY IF EXISTS tags_tenant_insert ON tags;
CREATE POLICY tags_tenant_insert ON tags
  FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tags_tenant_update ON tags;
CREATE POLICY tags_tenant_update ON tags
  FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tags_tenant_delete ON tags;
CREATE POLICY tags_tenant_delete ON tags
  FOR DELETE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tags_platform_access ON tags;
CREATE POLICY tags_platform_access ON tags
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tag_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tag_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tag_translations_tenant_select ON tag_translations;
CREATE POLICY tag_translations_tenant_select ON tag_translations
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM tags WHERE tags.id = tag_id));
DROP POLICY IF EXISTS tag_translations_tenant_insert ON tag_translations;
CREATE POLICY tag_translations_tenant_insert ON tag_translations
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM tags
    WHERE tags.id = tag_id
      AND tags.owner_type = 'tenant'
      AND tags.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS tag_translations_tenant_update ON tag_translations;
CREATE POLICY tag_translations_tenant_update ON tag_translations
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM tags
    WHERE tags.id = tag_id
      AND tags.owner_type = 'tenant'
      AND tags.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM tags
    WHERE tags.id = tag_id
      AND tags.owner_type = 'tenant'
      AND tags.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS tag_translations_tenant_delete ON tag_translations;
CREATE POLICY tag_translations_tenant_delete ON tag_translations
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM tags
    WHERE tags.id = tag_id
      AND tags.owner_type = 'tenant'
      AND tags.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS tag_translations_platform_access ON tag_translations;
CREATE POLICY tag_translations_platform_access ON tag_translations
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE dramas ENABLE ROW LEVEL SECURITY;
ALTER TABLE dramas FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dramas_tenant_select ON dramas;
CREATE POLICY dramas_tenant_select ON dramas
  FOR SELECT
  USING (
    (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
    OR (owner_type = 'platform' AND app.tenant_has_drama_license(id))
  );
DROP POLICY IF EXISTS dramas_tenant_insert ON dramas;
CREATE POLICY dramas_tenant_insert ON dramas
  FOR INSERT
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS dramas_tenant_update ON dramas;
CREATE POLICY dramas_tenant_update ON dramas
  FOR UPDATE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id())
  WITH CHECK (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS dramas_tenant_delete ON dramas;
CREATE POLICY dramas_tenant_delete ON dramas
  FOR DELETE
  USING (owner_type = 'tenant' AND owner_tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS dramas_platform_access ON dramas;
CREATE POLICY dramas_platform_access ON dramas
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE drama_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE drama_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drama_translations_tenant_select ON drama_translations;
CREATE POLICY drama_translations_tenant_select ON drama_translations
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM dramas WHERE dramas.id = drama_id));
DROP POLICY IF EXISTS drama_translations_tenant_insert ON drama_translations;
CREATE POLICY drama_translations_tenant_insert ON drama_translations
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS drama_translations_tenant_update ON drama_translations;
CREATE POLICY drama_translations_tenant_update ON drama_translations
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS drama_translations_tenant_delete ON drama_translations;
CREATE POLICY drama_translations_tenant_delete ON drama_translations
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS drama_translations_platform_access ON drama_translations;
CREATE POLICY drama_translations_platform_access ON drama_translations
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS episodes_tenant_select ON episodes;
CREATE POLICY episodes_tenant_select ON episodes
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM dramas WHERE dramas.id = drama_id));
DROP POLICY IF EXISTS episodes_tenant_insert ON episodes;
CREATE POLICY episodes_tenant_insert ON episodes
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episodes_tenant_update ON episodes;
CREATE POLICY episodes_tenant_update ON episodes
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episodes_tenant_delete ON episodes;
CREATE POLICY episodes_tenant_delete ON episodes
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episodes_platform_access ON episodes;
CREATE POLICY episodes_platform_access ON episodes
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE episode_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE episode_translations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS episode_translations_tenant_select ON episode_translations;
CREATE POLICY episode_translations_tenant_select ON episode_translations
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM episodes WHERE episodes.id = episode_id));
DROP POLICY IF EXISTS episode_translations_tenant_insert ON episode_translations;
CREATE POLICY episode_translations_tenant_insert ON episode_translations
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM episodes
    INNER JOIN dramas ON dramas.id = episodes.drama_id
    WHERE episodes.id = episode_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episode_translations_tenant_update ON episode_translations;
CREATE POLICY episode_translations_tenant_update ON episode_translations
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM episodes
    INNER JOIN dramas ON dramas.id = episodes.drama_id
    WHERE episodes.id = episode_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM episodes
    INNER JOIN dramas ON dramas.id = episodes.drama_id
    WHERE episodes.id = episode_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episode_translations_tenant_delete ON episode_translations;
CREATE POLICY episode_translations_tenant_delete ON episode_translations
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM episodes
    INNER JOIN dramas ON dramas.id = episodes.drama_id
    WHERE episodes.id = episode_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS episode_translations_platform_access ON episode_translations;
CREATE POLICY episode_translations_platform_access ON episode_translations
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE drama_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE drama_tags FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS drama_tags_tenant_select ON drama_tags;
CREATE POLICY drama_tags_tenant_select ON drama_tags
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM dramas WHERE dramas.id = drama_id));
DROP POLICY IF EXISTS drama_tags_tenant_insert ON drama_tags;
CREATE POLICY drama_tags_tenant_insert ON drama_tags
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS drama_tags_tenant_delete ON drama_tags;
CREATE POLICY drama_tags_tenant_delete ON drama_tags
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM dramas
    WHERE dramas.id = drama_id
      AND dramas.owner_type = 'tenant'
      AND dramas.owner_tenant_id = app.current_tenant_id()
  ));
DROP POLICY IF EXISTS drama_tags_platform_access ON drama_tags;
CREATE POLICY drama_tags_platform_access ON drama_tags
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_license_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_license_packages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_license_packages_platform_access ON content_license_packages;
CREATE POLICY content_license_packages_platform_access ON content_license_packages
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_license_package_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_license_package_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_license_package_items_platform_access
  ON content_license_package_items;
CREATE POLICY content_license_package_items_platform_access
  ON content_license_package_items
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_licenses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_licenses_tenant_isolation ON content_licenses;
DROP POLICY IF EXISTS content_licenses_tenant_select ON content_licenses;
CREATE POLICY content_licenses_tenant_select ON content_licenses
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_licenses_platform_access ON content_licenses;
CREATE POLICY content_licenses_platform_access ON content_licenses
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_license_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_license_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_license_items_tenant_isolation ON content_license_items;
DROP POLICY IF EXISTS content_license_items_tenant_select ON content_license_items;
CREATE POLICY content_license_items_tenant_select ON content_license_items
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_license_items_platform_access ON content_license_items;
CREATE POLICY content_license_items_platform_access ON content_license_items
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_versions_tenant_isolation ON content_versions;
DROP POLICY IF EXISTS content_versions_tenant_select ON content_versions;
CREATE POLICY content_versions_tenant_select ON content_versions
  FOR SELECT
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_versions_tenant_insert ON content_versions;
CREATE POLICY content_versions_tenant_insert ON content_versions
  FOR INSERT
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_versions_tenant_update ON content_versions;
DROP POLICY IF EXISTS content_versions_tenant_delete ON content_versions;
DROP POLICY IF EXISTS content_versions_platform_access ON content_versions;
CREATE POLICY content_versions_platform_access ON content_versions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_requests_tenant_isolation ON review_requests;
DROP POLICY IF EXISTS review_requests_tenant_select ON review_requests;
CREATE POLICY review_requests_tenant_select ON review_requests
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS review_requests_tenant_insert ON review_requests;
CREATE POLICY review_requests_tenant_insert ON review_requests
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND status = 'submitted'
    AND reviewed_at IS NULL
    AND reviewer_id IS NULL
  );
DROP POLICY IF EXISTS review_requests_tenant_withdraw ON review_requests;
CREATE POLICY review_requests_tenant_withdraw ON review_requests
  FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND status = 'submitted')
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND status = 'withdrawn'
    AND reviewed_at IS NULL
    AND reviewer_id IS NULL
  );
DROP POLICY IF EXISTS review_requests_platform_access ON review_requests;
CREATE POLICY review_requests_platform_access ON review_requests
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE review_request_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_request_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS review_request_actions_tenant_isolation ON review_request_actions;
DROP POLICY IF EXISTS review_request_actions_tenant_select ON review_request_actions;
CREATE POLICY review_request_actions_tenant_select ON review_request_actions
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS review_request_actions_tenant_insert ON review_request_actions;
CREATE POLICY review_request_actions_tenant_insert ON review_request_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND action IN ('submit', 'withdraw')
    AND actor_type = 'tenant_staff'
  );
DROP POLICY IF EXISTS review_request_actions_platform_access ON review_request_actions;
CREATE POLICY review_request_actions_platform_access ON review_request_actions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_schedule_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_schedule_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_schedule_jobs_tenant_isolation ON content_schedule_jobs;
CREATE POLICY content_schedule_jobs_tenant_isolation ON content_schedule_jobs
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_schedule_jobs_platform_access ON content_schedule_jobs;
CREATE POLICY content_schedule_jobs_platform_access ON content_schedule_jobs
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_deletion_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_deletion_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_deletion_history_tenant_isolation ON content_deletion_history;
CREATE POLICY content_deletion_history_tenant_isolation ON content_deletion_history
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_deletion_history_platform_access ON content_deletion_history;
CREATE POLICY content_deletion_history_platform_access ON content_deletion_history
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_import_jobs_tenant_isolation ON content_import_jobs;
CREATE POLICY content_import_jobs_tenant_isolation ON content_import_jobs
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_import_jobs_platform_access ON content_import_jobs;
CREATE POLICY content_import_jobs_platform_access ON content_import_jobs
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE content_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_import_rows FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_import_rows_tenant_isolation ON content_import_rows;
CREATE POLICY content_import_rows_tenant_isolation ON content_import_rows
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS content_import_rows_platform_access ON content_import_rows;
CREATE POLICY content_import_rows_platform_access ON content_import_rows
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE command_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS command_idempotency_tenant_isolation ON command_idempotency;
CREATE POLICY command_idempotency_tenant_isolation ON command_idempotency
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS command_idempotency_platform_access ON command_idempotency;
CREATE POLICY command_idempotency_platform_access ON command_idempotency
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;
CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS outbox_events_platform_access ON outbox_events;
CREATE POLICY outbox_events_platform_access ON outbox_events
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE outbox_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_consumptions_tenant_isolation ON outbox_consumptions;
CREATE POLICY outbox_consumptions_tenant_isolation ON outbox_consumptions
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS outbox_consumptions_platform_access ON outbox_consumptions;
CREATE POLICY outbox_consumptions_platform_access ON outbox_consumptions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMIT;
