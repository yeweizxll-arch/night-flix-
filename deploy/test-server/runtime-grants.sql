-- Run as the offline migration owner, after checked migrations. Runtime roles
-- never own tables, bypass RLS, or receive the migration password.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, app TO nf_tenant, nf_platform, nf_resolver;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nf_tenant, nf_platform;
REVOKE ALL ON public.schema_migrations FROM nf_tenant, nf_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nf_tenant, nf_platform;
-- Invoker-only helpers called by media/content triggers. Trigger EXECUTE itself
-- is checked at creation, but nested function calls use the runtime role.
-- Do not grant all app functions or grant these helpers to the host resolver.
GRANT EXECUTE ON FUNCTION app.scope_can_reference(text, uuid, text, uuid)
  TO nf_tenant, nf_platform;
GRANT EXECUTE ON FUNCTION app.content_target_matches_scope(text, uuid, text, uuid)
  TO nf_tenant, nf_platform;
-- Privacy/account and moderation triggers call this guarded boolean predicate.
-- It still requires a registered platform role and a matching pending request;
-- granting EXECUTE does not authorize a tenant to perform an erasure.
GRANT EXECUTE ON FUNCTION app.customer_erasure_authorized(uuid, uuid)
  TO nf_tenant, nf_platform;
INSERT INTO app.database_access_principals(role_name, access_scope)
VALUES ('nf_platform', 'platform') ON CONFLICT DO NOTHING;
GRANT EXECUTE ON FUNCTION app.resolve_tenant_by_host(text) TO nf_resolver;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nf_resolver;
