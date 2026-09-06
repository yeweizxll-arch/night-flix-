-- Customer authorization only. Operator review remains visible across regions.
CREATE OR REPLACE FUNCTION app.customer_region_allowed(target_tenant uuid, target_drama uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM public.tenant_app_runtime_configs AS config
      WHERE config.tenant_id = target_tenant
        AND cardinality(config.allowed_countries) > 0
        AND NOT coalesce(nullif(current_setting('app.request_country', true), '') = ANY(config.allowed_countries), false)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tenant_public_drama_publications AS publication
      WHERE publication.tenant_id = target_tenant AND publication.drama_id = target_drama
        AND (
          (cardinality(publication.allowed_countries) > 0
            AND NOT coalesce(nullif(current_setting('app.request_country', true), '') = ANY(publication.allowed_countries), false))
          OR (cardinality(publication.blocked_countries) > 0
            AND (nullif(current_setting('app.request_country', true), '') IS NULL
              OR current_setting('app.request_country', true) = ANY(publication.blocked_countries)))
        )
    )
$$;
