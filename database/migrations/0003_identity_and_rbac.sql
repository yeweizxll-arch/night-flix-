BEGIN;

CREATE TABLE IF NOT EXISTS platform_staff (
  id uuid PRIMARY KEY,
  username citext NOT NULL,
  email citext,
  phone text,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  mfa_enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT platform_staff_username_unique UNIQUE (username),
  CONSTRAINT platform_staff_email_unique UNIQUE (email),
  CONSTRAINT platform_staff_phone_unique UNIQUE (phone),
  CONSTRAINT platform_staff_username_check CHECK (
    username::text = lower(username::text)
    AND username::text ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  ),
  CONSTRAINT platform_staff_email_check CHECK (
    email IS NULL OR (
      email::text = lower(email::text)
      AND char_length(email::text) BETWEEN 3 AND 320
      AND email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  CONSTRAINT platform_staff_phone_check CHECK (
    phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT platform_staff_password_hash_check CHECK (char_length(password_hash) BETWEEN 20 AND 512),
  CONSTRAINT platform_staff_status_check CHECK (status IN ('active', 'disabled', 'locked')),
  CONSTRAINT platform_staff_version_check CHECK (version >= 0),
  CONSTRAINT platform_staff_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS platform_staff_status_idx ON platform_staff (status);

DROP TRIGGER IF EXISTS platform_staff_set_updated_at ON platform_staff;
CREATE TRIGGER platform_staff_set_updated_at
BEFORE UPDATE ON platform_staff
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS tenant_staff (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  username citext NOT NULL,
  email citext,
  phone text,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT tenant_staff_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_staff_username_unique UNIQUE (tenant_id, username),
  CONSTRAINT tenant_staff_email_unique UNIQUE (tenant_id, email),
  CONSTRAINT tenant_staff_phone_unique UNIQUE (tenant_id, phone),
  CONSTRAINT tenant_staff_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tenant_staff_username_check CHECK (
    username::text = lower(username::text)
    AND username::text ~ '^[a-z0-9][a-z0-9_.-]{2,63}$'
  ),
  CONSTRAINT tenant_staff_email_check CHECK (
    email IS NULL OR (
      email::text = lower(email::text)
      AND char_length(email::text) BETWEEN 3 AND 320
      AND email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  ),
  CONSTRAINT tenant_staff_phone_check CHECK (
    phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT tenant_staff_password_hash_check CHECK (char_length(password_hash) BETWEEN 20 AND 512),
  CONSTRAINT tenant_staff_status_check CHECK (status IN ('active', 'disabled', 'locked')),
  CONSTRAINT tenant_staff_version_check CHECK (version >= 0),
  CONSTRAINT tenant_staff_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tenant_staff_tenant_status_idx
  ON tenant_staff (tenant_id, status);

DROP TRIGGER IF EXISTS tenant_staff_set_updated_at ON tenant_staff;
CREATE TRIGGER tenant_staff_set_updated_at
BEFORE UPDATE ON tenant_staff
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS tenant_status_history (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  operator_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT tenant_status_history_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_status_history_operator_fk FOREIGN KEY (operator_id)
    REFERENCES platform_staff (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_status_history_from_status_check CHECK (
    from_status IN ('active', 'suspended', 'expired')
  ),
  CONSTRAINT tenant_status_history_to_status_check CHECK (
    to_status IN ('active', 'suspended', 'expired')
  ),
  CONSTRAINT tenant_status_history_transition_check CHECK (from_status <> to_status),
  CONSTRAINT tenant_status_history_reason_check CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT tenant_status_history_effective_timestamp_check CHECK (effective_at >= created_at)
);

CREATE INDEX IF NOT EXISTS tenant_status_history_tenant_effective_idx
  ON tenant_status_history (tenant_id, effective_at DESC, id);

DROP TRIGGER IF EXISTS tenant_status_history_prevent_update ON tenant_status_history;
CREATE TRIGGER tenant_status_history_prevent_update
BEFORE UPDATE OR DELETE ON tenant_status_history
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  name citext NOT NULL,
  status text NOT NULL DEFAULT 'active',
  is_system boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT roles_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT roles_scope_check CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT roles_name_check CHECK (char_length(btrim(name::text)) BETWEEN 1 AND 100),
  CONSTRAINT roles_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT roles_version_check CHECK (version >= 0),
  CONSTRAINT roles_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_platform_name_unique_idx
  ON roles (name)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_name_unique_idx
  ON roles (tenant_id, name)
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS roles_tenant_status_idx
  ON roles (tenant_id, status)
  WHERE scope_type = 'tenant';

DROP TRIGGER IF EXISTS roles_set_updated_at ON roles;
CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS permissions (
  id uuid PRIMARY KEY,
  code citext NOT NULL,
  module text NOT NULL,
  action text NOT NULL,
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT permissions_code_unique UNIQUE (code),
  CONSTRAINT permissions_code_check CHECK (
    code::text = lower(code::text)
    AND code::text ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$'
  ),
  CONSTRAINT permissions_module_check CHECK (module ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT permissions_action_check CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT permissions_description_check CHECK (char_length(description) <= 1000),
  CONSTRAINT permissions_version_check CHECK (version >= 0),
  CONSTRAINT permissions_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS permissions_module_action_idx
  ON permissions (module, action);

DROP TRIGGER IF EXISTS permissions_set_updated_at ON permissions;
CREATE TRIGGER permissions_set_updated_at
BEFORE UPDATE ON permissions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL,
  permission_id uuid NOT NULL,
  scope_type text NOT NULL,
  tenant_id uuid,
  data_scope text NOT NULL DEFAULT 'all',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT role_permissions_pk PRIMARY KEY (role_id, permission_id),
  CONSTRAINT role_permissions_role_fk FOREIGN KEY (role_id)
    REFERENCES roles (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT role_permissions_permission_fk FOREIGN KEY (permission_id)
    REFERENCES permissions (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT role_permissions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT role_permissions_scope_check CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL)
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT role_permissions_data_scope_check CHECK (data_scope IN ('all', 'own', 'assigned'))
);

CREATE INDEX IF NOT EXISTS role_permissions_permission_idx
  ON role_permissions (permission_id, role_id);

CREATE INDEX IF NOT EXISTS role_permissions_tenant_idx
  ON role_permissions (tenant_id, role_id)
  WHERE scope_type = 'tenant';

CREATE TABLE IF NOT EXISTS subject_roles (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid,
  CONSTRAINT subject_roles_role_fk FOREIGN KEY (role_id)
    REFERENCES roles (id) ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT subject_roles_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT subject_roles_scope_check CHECK (
    (scope_type = 'platform' AND tenant_id IS NULL AND subject_type = 'platform_staff')
    OR (scope_type = 'tenant' AND tenant_id IS NOT NULL AND subject_type = 'tenant_staff')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS subject_roles_platform_unique_idx
  ON subject_roles (subject_type, subject_id, role_id)
  WHERE scope_type = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS subject_roles_tenant_unique_idx
  ON subject_roles (tenant_id, subject_type, subject_id, role_id)
  WHERE scope_type = 'tenant';

CREATE INDEX IF NOT EXISTS subject_roles_role_idx ON subject_roles (role_id);

CREATE OR REPLACE FUNCTION app.enforce_role_permission_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  role_scope text;
  role_tenant uuid;
BEGIN
  SELECT scope_type, tenant_id
    INTO role_scope, role_tenant
  FROM roles
  WHERE id = NEW.role_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role % does not exist', NEW.role_id USING ERRCODE = '23503';
  END IF;

  IF role_scope <> NEW.scope_type OR role_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Role permission scope must match its role scope'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS role_permissions_enforce_scope ON role_permissions;
CREATE TRIGGER role_permissions_enforce_scope
BEFORE INSERT OR UPDATE OF role_id, scope_type, tenant_id ON role_permissions
FOR EACH ROW EXECUTE FUNCTION app.enforce_role_permission_scope();

CREATE OR REPLACE FUNCTION app.enforce_subject_role_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  role_scope text;
  role_tenant uuid;
  subject_exists boolean;
BEGIN
  SELECT scope_type, tenant_id
    INTO role_scope, role_tenant
  FROM roles
  WHERE id = NEW.role_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role % does not exist', NEW.role_id USING ERRCODE = '23503';
  END IF;

  IF role_scope <> NEW.scope_type OR role_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Subject role scope must match its role scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.subject_type = 'platform_staff' THEN
    SELECT EXISTS (
      SELECT 1 FROM platform_staff WHERE id = NEW.subject_id
    ) INTO subject_exists;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM tenant_staff
      WHERE id = NEW.subject_id AND tenant_id = NEW.tenant_id
    ) INTO subject_exists;
  END IF;

  IF NOT subject_exists THEN
    RAISE EXCEPTION 'Subject % does not exist in the requested scope', NEW.subject_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS subject_roles_enforce_scope ON subject_roles;
CREATE TRIGGER subject_roles_enforce_scope
BEFORE INSERT OR UPDATE OF role_id, scope_type, tenant_id, subject_type, subject_id ON subject_roles
FOR EACH ROW EXECUTE FUNCTION app.enforce_subject_role_scope();

COMMIT;
