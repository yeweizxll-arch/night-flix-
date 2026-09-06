BEGIN;

-- The offline migration owner also owns SECURITY DEFINER functions. FORCE RLS
-- remains enabled: explicitly register this non-runtime principal, never grant
-- runtime tenants BYPASSRLS or write access to public content/financial facts.
INSERT INTO app.database_access_principals (role_name, access_scope)
VALUES (current_user, 'platform') ON CONFLICT (role_name) DO NOTHING;

CREATE OR REPLACE FUNCTION app.lock_customer_row(
  relation_name text, row_id uuid, expected_row jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  tenant uuid := app.current_tenant_id();
  predicate text;
  locked_row jsonb;
BEGIN
  IF tenant IS NULL OR row_id IS NULL OR expected_row IS NULL THEN RETURN false; END IF;
  -- A closed table allowlist and tenant predicates are mandatory. This function
  -- only locks; it never returns another tenant's data and never mutates a row.
  CASE relation_name
    WHEN 'dramas' THEN predicate :=
      '(r.owner_type = ''tenant'' AND r.owner_tenant_id = $2) OR
       (r.owner_type = ''platform'' AND app.tenant_has_drama_license(r.id))';
    WHEN 'episodes' THEN predicate :=
      'EXISTS (SELECT 1 FROM public.dramas d WHERE d.id = r.drama_id AND
       ((d.owner_type = ''tenant'' AND d.owner_tenant_id = $2) OR
        (d.owner_type = ''platform'' AND app.tenant_has_drama_license(d.id))))';
    WHEN 'episode_media_tracks' THEN predicate :=
      'EXISTS (SELECT 1 FROM public.episodes e JOIN public.dramas d ON d.id = e.drama_id
       WHERE e.id = r.episode_id AND ((d.owner_type = ''tenant'' AND d.owner_tenant_id = $2)
       OR (d.owner_type = ''platform'' AND app.tenant_has_drama_license(d.id))))';
    WHEN 'media_assets' THEN predicate :=
      '(r.owner_type = ''tenant'' AND r.owner_tenant_id = $2) OR
       (r.owner_type = ''platform'' AND app.tenant_can_access_media(r.id))';
    WHEN 'storage_providers' THEN predicate :=
      '(r.owner_type = ''tenant'' AND r.owner_tenant_id = $2) OR
       (r.owner_type = ''platform'' AND r.status = ''active'')';
    WHEN 'entitlements', 'content_licenses', 'content_license_items', 'point_accounts'
      THEN predicate := 'r.tenant_id = $2';
    ELSE RAISE EXCEPTION 'Unsupported customer lock resource' USING ERRCODE = '22023';
  END CASE;
  EXECUTE format('SELECT to_jsonb(r) FROM public.%I r WHERE r.id = $1 AND (%s) FOR SHARE OF r',
    relation_name, predicate) INTO locked_row USING row_id, tenant;
  -- A concurrent change between the caller snapshot and lock must fail closed.
  RETURN coalesce(locked_row = expected_row, false);
END
$function$;
REVOKE ALL ON FUNCTION app.lock_customer_row(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lock_customer_row(text, uuid, jsonb) TO PUBLIC;

CREATE OR REPLACE FUNCTION app.freeze_public_release(requested_drama uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE target uuid;
BEGIN
  IF app.current_tenant_id() IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM tenant_public_drama_publications p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.tenant_id = app.current_tenant_id() AND p.drama_id = requested_drama
      AND p.status IN ('approved', 'unpublished')
      AND t.status = 'active' AND t.expires_at > statement_timestamp()
    FOR SHARE OF p, t;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE dramas SET public_release_locked_at = coalesce(public_release_locked_at, statement_timestamp())
    WHERE id = requested_drama AND owner_type = 'platform' AND owner_tenant_id IS NULL
      AND status = 'published' AND deleted_at IS NULL AND emergency_takedown_at IS NULL
    RETURNING id INTO target;
  RETURN target IS NOT NULL;
END
$function$;
GRANT EXECUTE ON FUNCTION app.freeze_public_release(uuid) TO PUBLIC;

-- Customer catalog visibility is narrower than the operator's review-pool RLS.
CREATE OR REPLACE FUNCTION app.tenant_drama_published(requested_drama uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $function$
  SELECT app.current_tenant_id() IS NOT NULL AND coalesce((
    SELECT status = 'published' FROM tenant_public_drama_publications
    WHERE tenant_id = app.current_tenant_id() AND drama_id = requested_drama
  ), EXISTS (
    SELECT 1 FROM content_licenses l JOIN content_license_items i
      ON i.license_id = l.id AND i.tenant_id = l.tenant_id
    WHERE l.tenant_id = app.current_tenant_id() AND i.drama_id = requested_drama
      AND l.status IN ('active', 'scheduled')
      AND l.starts_at <= statement_timestamp() AND l.expires_at > statement_timestamp()
  ));
$function$;
GRANT EXECUTE ON FUNCTION app.tenant_drama_published(uuid) TO PUBLIC;

CREATE OR REPLACE FUNCTION app.enforce_point_unlock_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  resolved_drama_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM point_accounts AS account
    WHERE account.tenant_id = NEW.tenant_id
      AND account.account_id = NEW.account_id
      AND account.id = NEW.point_account_id
  ) THEN
    RAISE EXCEPTION 'Point unlock account binding is invalid' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM content_point_prices AS price
    WHERE price.tenant_id = NEW.tenant_id
      AND price.id = NEW.price_id
      AND price.target_type = NEW.target_type
      AND price.target_id = NEW.target_id
      AND price.status = 'active'
      AND price.version = NEW.price_version_snapshot
      AND price.points_amount = NEW.points_amount_snapshot
  ) THEN
    RAISE EXCEPTION 'Point unlock price snapshot is invalid' USING ERRCODE = '23514';
  END IF;

  IF NEW.target_type = 'drama' THEN
    SELECT drama.id INTO resolved_drama_id
    FROM dramas AS drama
    WHERE drama.id = NEW.target_id
      AND drama.status = 'published'
      AND drama.deleted_at IS NULL
      AND drama.emergency_takedown_at IS NULL
      AND (
        (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
        OR (
          drama.owner_type = 'platform'
          AND coalesce((SELECT p.status = 'published'
            FROM tenant_public_drama_publications p
            WHERE p.tenant_id = NEW.tenant_id AND p.drama_id = drama.id), EXISTS (
            SELECT 1
            FROM content_license_items AS item
            INNER JOIN content_licenses AS license
              ON license.id = item.license_id
              AND license.tenant_id = item.tenant_id
            WHERE item.tenant_id = NEW.tenant_id
              AND item.drama_id = drama.id
              AND license.status IN ('scheduled', 'active')
              AND license.starts_at <= transaction_timestamp()
              AND license.expires_at > transaction_timestamp()
          ))
        )
      );
  ELSE
    SELECT drama.id INTO resolved_drama_id
    FROM episodes AS episode
    INNER JOIN dramas AS drama ON drama.id = episode.drama_id
    WHERE episode.id = NEW.target_id
      AND episode.status = 'published'
      AND episode.deleted_at IS NULL
      AND drama.status = 'published'
      AND drama.deleted_at IS NULL
      AND drama.emergency_takedown_at IS NULL
      AND (
        (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
        OR (
          drama.owner_type = 'platform'
          AND coalesce((SELECT p.status = 'published'
            FROM tenant_public_drama_publications p
            WHERE p.tenant_id = NEW.tenant_id AND p.drama_id = drama.id), EXISTS (
            SELECT 1
            FROM content_license_items AS item
            INNER JOIN content_licenses AS license
              ON license.id = item.license_id
              AND license.tenant_id = item.tenant_id
            WHERE item.tenant_id = NEW.tenant_id
              AND item.drama_id = drama.id
              AND license.status IN ('scheduled', 'active')
              AND license.starts_at <= transaction_timestamp()
              AND license.expires_at > transaction_timestamp()
          ))
        )
      );
  END IF;

  IF resolved_drama_id IS NULL OR resolved_drama_id <> NEW.drama_id THEN
    RAISE EXCEPTION 'Point unlock target is not currently sellable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

COMMIT;
