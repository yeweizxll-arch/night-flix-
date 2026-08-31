BEGIN;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_tenant_isolation ON tenants;
CREATE POLICY tenants_tenant_isolation ON tenants
  FOR ALL
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
DROP POLICY IF EXISTS tenants_platform_access ON tenants;
CREATE POLICY tenants_platform_access ON tenants
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_domains NO FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_domains_tenant_isolation ON tenant_domains;
CREATE POLICY tenant_domains_tenant_isolation ON tenant_domains
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_domains_platform_access ON tenant_domains;
CREATE POLICY tenant_domains_platform_access ON tenant_domains
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_staff FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_staff_tenant_isolation ON tenant_staff;
CREATE POLICY tenant_staff_tenant_isolation ON tenant_staff
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_staff_platform_access ON tenant_staff;
CREATE POLICY tenant_staff_platform_access ON tenant_staff
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_status_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_status_history_tenant_isolation ON tenant_status_history;
CREATE POLICY tenant_status_history_tenant_isolation ON tenant_status_history
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_status_history_platform_access ON tenant_status_history;
CREATE POLICY tenant_status_history_platform_access ON tenant_status_history
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roles_tenant_isolation ON roles;
CREATE POLICY roles_tenant_isolation ON roles
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS roles_platform_access ON roles;
CREATE POLICY roles_platform_access ON roles
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS role_permissions_platform_access ON role_permissions;
CREATE POLICY role_permissions_platform_access ON role_permissions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE subject_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subject_roles_tenant_isolation ON subject_roles;
CREATE POLICY subject_roles_tenant_isolation ON subject_roles
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS subject_roles_platform_access ON subject_roles;
CREATE POLICY subject_roles_platform_access ON subject_roles
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_sessions_tenant_isolation ON auth_sessions;
CREATE POLICY auth_sessions_tenant_isolation ON auth_sessions
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS auth_sessions_platform_access ON auth_sessions;
CREATE POLICY auth_sessions_platform_access ON auth_sessions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE auth_refresh_token_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_refresh_token_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_refresh_history_tenant_isolation ON auth_refresh_token_history;
CREATE POLICY auth_refresh_history_tenant_isolation ON auth_refresh_token_history
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS auth_refresh_history_platform_access ON auth_refresh_token_history;
CREATE POLICY auth_refresh_history_platform_access ON auth_refresh_token_history
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS audit_logs_platform_access ON audit_logs;
CREATE POLICY audit_logs_platform_access ON audit_logs
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMIT;
