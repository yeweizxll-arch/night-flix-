-- Reviewed, minimal repair for already provisioned Night Flix runtime roles.
-- These SECURITY INVOKER helpers do not bypass RLS or mutate data.
BEGIN;
GRANT EXECUTE ON FUNCTION app.scope_can_reference(text, uuid, text, uuid) TO nf_tenant, nf_platform;
GRANT EXECUTE ON FUNCTION app.content_target_matches_scope(text, uuid, text, uuid) TO nf_tenant, nf_platform;
COMMIT;
