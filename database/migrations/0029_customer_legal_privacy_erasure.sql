BEGIN;

CREATE TABLE IF NOT EXISTS tenant_legal_document_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_type text NOT NULL,
  locale text NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  body_markdown text NOT NULL,
  effective_at timestamptz,
  required_for_registration boolean NOT NULL DEFAULT false,
  row_version integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  published_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tenant_legal_documents_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_legal_documents_tenant_id_id_unique
    UNIQUE (tenant_id, id),
  CONSTRAINT tenant_legal_documents_version_unique
    UNIQUE (tenant_id, document_type, locale, version_no),
  CONSTRAINT tenant_legal_documents_identity_version_unique
    UNIQUE (tenant_id, id, version_no),
  CONSTRAINT tenant_legal_documents_type_check CHECK (
    document_type IN ('privacy', 'terms', 'refund', 'community')
  ),
  CONSTRAINT tenant_legal_documents_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT tenant_legal_documents_version_check CHECK (
    version_no BETWEEN 1 AND 2147483647 AND row_version >= 0
  ),
  CONSTRAINT tenant_legal_documents_status_check CHECK (
    status IN ('draft', 'published')
  ),
  CONSTRAINT tenant_legal_documents_content_check CHECK (
    char_length(btrim(title)) BETWEEN 1 AND 200
    AND char_length(body_markdown) BETWEEN 1 AND 200000
    -- The first release accepts Markdown text but no raw HTML/autolink syntax.
    AND strpos(body_markdown, '<') = 0
    AND strpos(body_markdown, '>') = 0
  ),
  CONSTRAINT tenant_legal_documents_publication_check CHECK (
    (
      status = 'draft'
      AND effective_at IS NULL AND published_by IS NULL AND published_at IS NULL
    ) OR (
      status = 'published'
      AND effective_at IS NOT NULL AND published_by IS NOT NULL
      AND published_at IS NOT NULL
    )
  ),
  CONSTRAINT tenant_legal_documents_timestamp_check CHECK (
    updated_at >= created_at AND (published_at IS NULL OR published_at >= created_at)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_legal_documents_one_draft_idx
  ON tenant_legal_document_versions (tenant_id, document_type, locale)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS tenant_legal_documents_current_idx
  ON tenant_legal_document_versions (
    tenant_id, document_type, locale, effective_at DESC, version_no DESC
  ) WHERE status = 'published';

CREATE OR REPLACE FUNCTION app.enforce_legal_document_version()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'published' THEN
      RAISE EXCEPTION 'Published legal document versions are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Legal document versions must be created as drafts'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'Published legal document versions are append-only'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.document_type <> OLD.document_type OR NEW.locale <> OLD.locale
    OR NEW.version_no <> OLD.version_no OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Legal document version identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'Legal document row version must advance by one'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status NOT IN ('draft', 'published')
    OR (NEW.status <> OLD.status AND NEW.status <> 'published')
  THEN
    RAISE EXCEPTION 'Legal document status transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'published' AND OLD.status = 'draft' THEN
    IF NEW.published_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'Legal document publication must use the database clock'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS tenant_legal_documents_enforce_version
  ON tenant_legal_document_versions;
CREATE TRIGGER tenant_legal_documents_enforce_version
BEFORE INSERT OR UPDATE OR DELETE ON tenant_legal_document_versions
FOR EACH ROW EXECUTE FUNCTION app.enforce_legal_document_version();

DROP TRIGGER IF EXISTS tenant_legal_documents_set_updated_at
  ON tenant_legal_document_versions;
CREATE TRIGGER tenant_legal_documents_set_updated_at
BEFORE UPDATE ON tenant_legal_document_versions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_legal_consents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version_no integer NOT NULL,
  document_type text NOT NULL,
  locale text NOT NULL,
  consent_source text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_legal_consents_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_legal_consents_document_fk
    FOREIGN KEY (tenant_id, document_id, document_version_no)
    REFERENCES tenant_legal_document_versions (tenant_id, id, version_no)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_legal_consents_unique
    UNIQUE (tenant_id, account_id, document_id, document_version_no),
  CONSTRAINT customer_legal_consents_type_check CHECK (
    document_type IN ('privacy', 'terms', 'refund', 'community')
  ),
  CONSTRAINT customer_legal_consents_locale_check CHECK (
    locale IN ('zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR')
  ),
  CONSTRAINT customer_legal_consents_source_check CHECK (
    consent_source IN ('registration', 'privacy_center')
  ),
  CONSTRAINT customer_legal_consents_timestamp_check CHECK (
    consented_at = created_at
  )
);

CREATE INDEX IF NOT EXISTS customer_legal_consents_account_idx
  ON customer_legal_consents (tenant_id, account_id, consented_at DESC, id DESC);

CREATE OR REPLACE FUNCTION app.enforce_customer_legal_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenant_legal_document_versions AS document
    WHERE document.tenant_id = NEW.tenant_id
      AND document.id = NEW.document_id
      AND document.version_no = NEW.document_version_no
      AND document.document_type = NEW.document_type
      AND document.locale = NEW.locale
      AND document.status = 'published'
      AND document.effective_at <= transaction_timestamp()
  ) THEN
    RAISE EXCEPTION 'Consent must reference an effective published legal document version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_legal_consents_enforce_document
  ON customer_legal_consents;
CREATE TRIGGER customer_legal_consents_enforce_document
BEFORE INSERT ON customer_legal_consents
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_legal_consent();

DROP TRIGGER IF EXISTS customer_legal_consents_prevent_mutation
  ON customer_legal_consents;
CREATE TRIGGER customer_legal_consents_prevent_mutation
BEFORE UPDATE OR DELETE ON customer_legal_consents
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS tenant_privacy_settings (
  tenant_id uuid PRIMARY KEY,
  financial_retention_days integer NOT NULL DEFAULT 2555,
  security_audit_retention_days integer NOT NULL DEFAULT 365,
  erasure_processing_days integer NOT NULL DEFAULT 30,
  version integer NOT NULL DEFAULT 0,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT tenant_privacy_settings_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT tenant_privacy_settings_ranges_check CHECK (
    financial_retention_days BETWEEN 0 AND 3650
    AND security_audit_retention_days BETWEEN 0 AND 3650
    AND erasure_processing_days BETWEEN 1 AND 90
  ),
  CONSTRAINT tenant_privacy_settings_version_check CHECK (version >= 0),
  CONSTRAINT tenant_privacy_settings_timestamp_check CHECK (updated_at >= created_at)
);

DROP TRIGGER IF EXISTS tenant_privacy_settings_set_updated_at
  ON tenant_privacy_settings;
CREATE TRIGGER tenant_privacy_settings_set_updated_at
BEFORE UPDATE ON tenant_privacy_settings
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS tenant_privacy_settings_prevent_delete
  ON tenant_privacy_settings;
CREATE TRIGGER tenant_privacy_settings_prevent_delete
BEFORE DELETE ON tenant_privacy_settings
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS customer_privacy_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  request_type text NOT NULL,
  status text NOT NULL DEFAULT 'submitted',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  password_reverified_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  processing_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  data_erasure_performed boolean NOT NULL DEFAULT false,
  retention_summary_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  subprocessor_status_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 10,
  locked_at timestamptz,
  locked_by text,
  failure_code text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_privacy_requests_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_privacy_requests_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT customer_privacy_requests_idempotency_unique
    UNIQUE (tenant_id, account_id, request_type, idempotency_key),
  CONSTRAINT customer_privacy_requests_type_check CHECK (
    request_type IN ('account_erasure', 'data_access', 'correction', 'restrict_processing')
  ),
  CONSTRAINT customer_privacy_requests_status_check CHECK (
    status IN ('submitted', 'processing', 'completed', 'failed')
  ),
  CONSTRAINT customer_privacy_requests_idempotency_check CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  CONSTRAINT customer_privacy_requests_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT customer_privacy_requests_attempt_check CHECK (
    attempt_count BETWEEN 0 AND max_attempts AND max_attempts BETWEEN 1 AND 20
  ),
  CONSTRAINT customer_privacy_requests_json_check CHECK (
    jsonb_typeof(retention_summary_json) = 'array'
    AND jsonb_typeof(subprocessor_status_json) = 'array'
  ),
  CONSTRAINT customer_privacy_requests_completion_check CHECK (
    (
      status = 'submitted' AND processing_at IS NULL AND completed_at IS NULL
      AND failed_at IS NULL AND NOT data_erasure_performed
      AND locked_at IS NULL AND locked_by IS NULL AND failure_code IS NULL
    ) OR (
      status = 'processing' AND processing_at IS NOT NULL AND completed_at IS NULL
      AND failed_at IS NULL AND NOT data_erasure_performed
      AND locked_at IS NOT NULL AND locked_by IS NOT NULL AND failure_code IS NULL
    ) OR (
      status = 'completed' AND processing_at IS NOT NULL AND completed_at IS NOT NULL
      AND failed_at IS NULL AND data_erasure_performed
      AND locked_at IS NULL AND locked_by IS NULL AND failure_code IS NULL
    ) OR (
      status = 'failed' AND processing_at IS NOT NULL AND completed_at IS NULL
      AND failed_at IS NOT NULL AND NOT data_erasure_performed
      AND locked_at IS NULL AND locked_by IS NULL
      AND failure_code IN ('retry_exhausted', 'database_error')
    )
  ),
  CONSTRAINT customer_privacy_requests_time_check CHECK (
    password_reverified_at = submitted_at
    AND available_at >= submitted_at
    AND (processing_at IS NULL OR processing_at >= submitted_at)
    AND (completed_at IS NULL OR completed_at >= processing_at)
    AND (failed_at IS NULL OR failed_at >= processing_at)
    AND updated_at >= created_at
  ),
  CONSTRAINT customer_privacy_requests_version_check CHECK (version >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_privacy_requests_active_erasure_idx
  ON customer_privacy_requests (tenant_id, account_id)
  WHERE request_type = 'account_erasure' AND status IN ('submitted', 'processing');

CREATE INDEX IF NOT EXISTS customer_privacy_requests_worker_idx
  ON customer_privacy_requests (available_at, submitted_at, id)
  WHERE request_type = 'account_erasure' AND status IN ('submitted', 'processing');

CREATE INDEX IF NOT EXISTS customer_privacy_requests_tenant_history_idx
  ON customer_privacy_requests (tenant_id, submitted_at DESC, id DESC);

DROP TRIGGER IF EXISTS customer_privacy_requests_set_updated_at
  ON customer_privacy_requests;
CREATE TRIGGER customer_privacy_requests_set_updated_at
BEFORE UPDATE ON customer_privacy_requests
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TABLE IF NOT EXISTS customer_privacy_retention_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  data_category text NOT NULL,
  reason_code text NOT NULL,
  retained_until timestamptz NOT NULL,
  record_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT customer_privacy_retention_request_fk FOREIGN KEY (tenant_id, request_id)
    REFERENCES customer_privacy_requests (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_privacy_retention_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT customer_privacy_retention_unique UNIQUE (request_id, data_category),
  CONSTRAINT customer_privacy_retention_category_check CHECK (
    data_category IN ('commerce_finance', 'commission_finance', 'security_audit')
  ),
  CONSTRAINT customer_privacy_retention_reason_check CHECK (
    reason_code IN ('accounting_and_tax', 'contract_and_dispute', 'security_and_fraud')
  ),
  CONSTRAINT customer_privacy_retention_count_check CHECK (record_count >= 0),
  CONSTRAINT customer_privacy_retention_time_check CHECK (retained_until > created_at)
);

CREATE INDEX IF NOT EXISTS customer_privacy_retention_account_idx
  ON customer_privacy_retention_items (tenant_id, account_id, retained_until, id);

DROP TRIGGER IF EXISTS customer_privacy_retention_prevent_mutation
  ON customer_privacy_retention_items;
CREATE TRIGGER customer_privacy_retention_prevent_mutation
BEFORE UPDATE OR DELETE ON customer_privacy_retention_items
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

-- Account erasure is a privileged domain transition. A freely settable GUC alone is
-- never sufficient: the caller must also be a registered platform database role and
-- the GUC must name an active request for the exact tenant/account pair.
CREATE OR REPLACE FUNCTION app.customer_erasure_authorized(
  requested_tenant uuid,
  requested_account uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
  SELECT app.has_platform_access(
      CASE
        WHEN current_setting('role', true) IS NULL
          OR current_setting('role', true) IN ('', 'none')
        THEN session_user::name
        ELSE current_setting('role', true)::name
      END
    )
    AND EXISTS (
      SELECT 1
      FROM public.customer_privacy_requests AS request
      WHERE request.id::text = nullif(
          current_setting('app.customer_erasure_request_id', true), ''
        )
        AND request.tenant_id = requested_tenant
        AND request.account_id = requested_account
        AND request.request_type = 'account_erasure'
        AND request.status IN ('submitted', 'processing')
    )
$function$;

ALTER TABLE customer_accounts ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE customer_accounts DROP CONSTRAINT IF EXISTS customer_accounts_password_check;
ALTER TABLE customer_accounts ADD CONSTRAINT customer_accounts_password_check CHECK (
  (status = 'erased' AND password_hash IS NULL)
  OR (
    status <> 'erased' AND password_hash IS NOT NULL
    AND char_length(password_hash) BETWEEN 20 AND 512
  )
);
ALTER TABLE customer_accounts DROP CONSTRAINT IF EXISTS customer_accounts_status_check;
ALTER TABLE customer_accounts ADD CONSTRAINT customer_accounts_status_check CHECK (
  status IN ('active', 'disabled', 'erasure_pending', 'erased')
);
ALTER TABLE customer_accounts DROP CONSTRAINT IF EXISTS customer_accounts_disable_check;
ALTER TABLE customer_accounts ADD CONSTRAINT customer_accounts_disable_check CHECK (
  (
    status = 'active'
    AND disabled_at IS NULL AND disabled_by IS NULL AND disable_reason IS NULL
  ) OR (
    status = 'disabled'
    AND disabled_at IS NOT NULL AND disabled_by IS NOT NULL
    AND disable_reason IS NOT NULL
    AND char_length(btrim(disable_reason)) BETWEEN 1 AND 1000
  ) OR (
    status = 'erasure_pending'
    AND disabled_at IS NOT NULL AND disabled_by = id
    AND disable_reason = 'account_erasure_requested'
  ) OR (
    status = 'erased'
    AND disabled_at IS NOT NULL AND disabled_by = id
    AND disable_reason = 'account_erased'
    AND username::text ~ '^erased_[0-9a-f]{32}$'
    AND email IS NULL AND phone IS NULL
    AND email_verified_at IS NULL AND phone_verified_at IS NULL
  )
);

CREATE OR REPLACE FUNCTION app.enforce_customer_account_privacy_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'New customer accounts must be active' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.status = 'erased' AND ROW(
    NEW.username, NEW.email, NEW.phone, NEW.password_hash,
    NEW.email_verified_at, NEW.phone_verified_at, NEW.status,
    NEW.disabled_at, NEW.disabled_by, NEW.disable_reason
  ) IS DISTINCT FROM ROW(
    OLD.username, OLD.email, OLD.phone, OLD.password_hash,
    OLD.email_verified_at, OLD.phone_verified_at, OLD.status,
    OLD.disabled_at, OLD.disabled_by, OLD.disable_reason
  ) THEN
    RAISE EXCEPTION 'Erased customer identities cannot be restored or changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IN ('erasure_pending', 'erased')
    AND NEW.status IS DISTINCT FROM OLD.status
  THEN
    IF NOT app.customer_erasure_authorized(OLD.tenant_id, OLD.id) THEN
      RAISE EXCEPTION 'Customer erasure transition requires an authorized request'
        USING ERRCODE = '42501';
    END IF;
    IF NOT (
      (OLD.status IN ('active', 'disabled') AND NEW.status = 'erasure_pending')
      OR (OLD.status = 'erasure_pending' AND NEW.status = 'erased')
    ) THEN
      RAISE EXCEPTION 'Customer erasure status transition is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.status IN ('erasure_pending', 'erased')
    AND NEW.status NOT IN ('erasure_pending', 'erased')
  THEN
    RAISE EXCEPTION 'Customer erasure cannot be cancelled or restored'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS customer_accounts_enforce_privacy_transition
  ON customer_accounts;
CREATE TRIGGER customer_accounts_enforce_privacy_transition
BEFORE INSERT OR UPDATE ON customer_accounts
FOR EACH ROW EXECUTE FUNCTION app.enforce_customer_account_privacy_transition();

-- Preserve commercial amounts and state, but permit exactly one anonymous snapshot
-- replacement while processing the bound erasure request.
CREATE OR REPLACE FUNCTION app.protect_order_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  snapshot_changed boolean;
BEGIN
  snapshot_changed := NEW.customer_snapshot_json IS DISTINCT FROM OLD.customer_snapshot_json;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.order_no IS DISTINCT FROM OLD.order_no
    OR NEW.order_type IS DISTINCT FROM OLD.order_type
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.locale IS DISTINCT FROM OLD.locale
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Order commercial snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF snapshot_changed AND NOT (
    app.customer_erasure_authorized(OLD.tenant_id, OLD.account_id)
    AND NEW.customer_snapshot_json = jsonb_build_object(
      'erased', true, 'subjectId', OLD.account_id
    )
  ) THEN
    RAISE EXCEPTION 'Order customer snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'pending_payment' AND NEW.status = 'paid' THEN
      IF OLD.expires_at <= transaction_timestamp() THEN
        RAISE EXCEPTION 'Expired pending orders cannot be paid' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.status = 'pending_payment' AND NEW.status IN ('expired', 'cancelled') THEN
      NULL;
    ELSIF OLD.status = 'paid' AND NEW.status = 'refunded' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'Order status transition is not allowed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.protect_audit_log_or_customer_erasure()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  erased_account uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rows in audit tables are immutable' USING ERRCODE = '55000';
  END IF;
  erased_account := CASE
    WHEN OLD.actor_type = 'user' THEN OLD.actor_id
    WHEN OLD.resource_type = 'customer_account' THEN OLD.resource_id
    ELSE NULL
  END;
  IF erased_account IS NULL
    OR NOT app.customer_erasure_authorized(OLD.tenant_id, erased_account)
    OR NEW.before_json IS DISTINCT FROM jsonb_build_object('redacted', 'customer_erasure')
    OR NEW.after_json IS DISTINCT FROM jsonb_build_object('redacted', 'customer_erasure')
    OR NEW.ip IS NOT NULL OR NEW.user_agent IS NOT NULL
    OR ROW(
      NEW.id, NEW.scope_type, NEW.tenant_id, NEW.actor_type, NEW.actor_id,
      NEW.action, NEW.resource_type, NEW.resource_id, NEW.request_id, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.scope_type, OLD.tenant_id, OLD.actor_type, OLD.actor_id,
      OLD.action, OLD.resource_type, OLD.resource_id, OLD.request_id, OLD.created_at
    )
  THEN
    RAISE EXCEPTION 'Audit rows are immutable except for authorized customer redaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS audit_logs_prevent_update ON audit_logs;
CREATE TRIGGER audit_logs_prevent_update
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION app.protect_audit_log_or_customer_erasure();

CREATE OR REPLACE FUNCTION app.freeze_interaction_comment_structure()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF app.customer_erasure_authorized(OLD.tenant_id, OLD.account_id)
    AND NEW.body = '[content erased]'
    AND NEW.sensitive_match_ids = '{}'::uuid[]
    AND ROW(NEW.tenant_id, NEW.drama_id, NEW.episode_id, NEW.account_id, NEW.parent_id)
      IS NOT DISTINCT FROM
      ROW(OLD.tenant_id, OLD.drama_id, OLD.episode_id, OLD.account_id, OLD.parent_id)
  THEN RETURN NEW; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.drama_id <> OLD.drama_id
    OR NEW.episode_id IS DISTINCT FROM OLD.episode_id OR NEW.account_id <> OLD.account_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id OR NEW.body <> OLD.body
    OR NEW.sensitive_match_ids IS DISTINCT FROM OLD.sensitive_match_ids
  THEN
    RAISE EXCEPTION 'comment identity, content, body, and moderation matches are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.freeze_interaction_bullet_structure()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF app.customer_erasure_authorized(OLD.tenant_id, OLD.account_id)
    AND NEW.body = '[content erased]'
    AND NEW.sensitive_match_ids = '{}'::uuid[]
    AND ROW(NEW.tenant_id, NEW.drama_id, NEW.episode_id, NEW.account_id, NEW.position_ms)
      IS NOT DISTINCT FROM
      ROW(OLD.tenant_id, OLD.drama_id, OLD.episode_id, OLD.account_id, OLD.position_ms)
  THEN RETURN NEW; END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.drama_id <> OLD.drama_id
    OR NEW.episode_id <> OLD.episode_id OR NEW.account_id <> OLD.account_id
    OR NEW.position_ms <> OLD.position_ms OR NEW.body <> OLD.body
    OR NEW.sensitive_match_ids IS DISTINCT FROM OLD.sensitive_match_ids
  THEN
    RAISE EXCEPTION 'bullet identity, position, body, and moderation matches are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.freeze_interaction_report_structure()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF app.customer_erasure_authorized(OLD.tenant_id, OLD.reporter_account_id)
    AND NEW.details IS NULL
    AND ROW(NEW.tenant_id, NEW.reporter_account_id, NEW.target_type,
      NEW.target_id, NEW.reason_category)
      IS NOT DISTINCT FROM
      ROW(OLD.tenant_id, OLD.reporter_account_id, OLD.target_type,
      OLD.target_id, OLD.reason_category)
  THEN RETURN NEW; END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.reporter_account_id <> OLD.reporter_account_id
    OR NEW.target_type <> OLD.target_type OR NEW.target_id <> OLD.target_id
    OR NEW.reason_category <> OLD.reason_category
    OR NEW.details IS DISTINCT FROM OLD.details
  THEN
    RAISE EXCEPTION 'report target, reporter, and reason snapshot are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.prevent_customer_secret_delete_unless_erasing()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_account uuid;
  target_tenant uuid;
BEGIN
  target_tenant := OLD.tenant_id;
  target_account := CASE
    WHEN TG_TABLE_NAME = 'customer_otp_delivery_jobs' THEN (
      SELECT challenge.account_id FROM customer_otp_challenges AS challenge
      WHERE challenge.id = nullif(to_jsonb(OLD) ->> 'challenge_id', '')::uuid
        AND challenge.tenant_id = OLD.tenant_id
    )
    ELSE nullif(to_jsonb(OLD) ->> 'account_id', '')::uuid
  END;
  IF target_account IS NULL
    OR NOT app.customer_erasure_authorized(target_tenant, target_account)
  THEN
    RAISE EXCEPTION 'Customer secrets are immutable outside authorized erasure'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END
$function$;

DROP TRIGGER IF EXISTS customer_refresh_history_prevent_update
  ON customer_refresh_token_history;
CREATE TRIGGER customer_refresh_history_prevent_update
BEFORE UPDATE OR DELETE ON customer_refresh_token_history
FOR EACH ROW EXECUTE FUNCTION app.prevent_customer_secret_delete_unless_erasing();

DROP TRIGGER IF EXISTS customer_push_tokens_prevent_delete ON customer_push_tokens;
CREATE TRIGGER customer_push_tokens_prevent_delete
BEFORE DELETE ON customer_push_tokens
FOR EACH ROW EXECUTE FUNCTION app.prevent_customer_secret_delete_unless_erasing();

DROP TRIGGER IF EXISTS customer_inbox_messages_prevent_delete ON customer_inbox_messages;
CREATE TRIGGER customer_inbox_messages_prevent_delete
BEFORE DELETE ON customer_inbox_messages
FOR EACH ROW EXECUTE FUNCTION app.prevent_customer_secret_delete_unless_erasing();

DROP TRIGGER IF EXISTS customer_otp_delivery_jobs_prevent_delete
  ON customer_otp_delivery_jobs;
CREATE TRIGGER customer_otp_delivery_jobs_prevent_delete
BEFORE DELETE ON customer_otp_delivery_jobs
FOR EACH ROW EXECUTE FUNCTION app.prevent_customer_secret_delete_unless_erasing();

CREATE OR REPLACE FUNCTION app.protect_referral_code_or_customer_erasure()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Referral codes are immutable' USING ERRCODE = '55000';
  END IF;
  IF app.customer_erasure_authorized(OLD.tenant_id, OLD.account_id)
    AND NEW.code ~ '^ER[A-F2-9]{8}$'
    AND ROW(NEW.id, NEW.tenant_id, NEW.account_id, NEW.created_at)
      IS NOT DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.account_id, OLD.created_at)
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Referral codes are immutable' USING ERRCODE = '55000';
END
$function$;

DROP TRIGGER IF EXISTS customer_referral_codes_prevent_mutation
  ON customer_referral_codes;
CREATE TRIGGER customer_referral_codes_prevent_mutation
BEFORE UPDATE OR DELETE ON customer_referral_codes
FOR EACH ROW EXECUTE FUNCTION app.protect_referral_code_or_customer_erasure();

ALTER TABLE tenant_legal_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_legal_document_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_legal_documents_tenant_access
  ON tenant_legal_document_versions;
CREATE POLICY tenant_legal_documents_tenant_access ON tenant_legal_document_versions
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_legal_documents_platform_access
  ON tenant_legal_document_versions;
CREATE POLICY tenant_legal_documents_platform_access ON tenant_legal_document_versions
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_legal_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_legal_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_legal_consents_tenant_select ON customer_legal_consents;
CREATE POLICY customer_legal_consents_tenant_select ON customer_legal_consents
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_legal_consents_platform_access ON customer_legal_consents;
CREATE POLICY customer_legal_consents_platform_access ON customer_legal_consents
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE tenant_privacy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_privacy_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_privacy_settings_tenant_access ON tenant_privacy_settings;
CREATE POLICY tenant_privacy_settings_tenant_access ON tenant_privacy_settings
  FOR ALL USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS tenant_privacy_settings_platform_access ON tenant_privacy_settings;
CREATE POLICY tenant_privacy_settings_platform_access ON tenant_privacy_settings
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_privacy_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_privacy_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_privacy_requests_tenant_select ON customer_privacy_requests;
CREATE POLICY customer_privacy_requests_tenant_select ON customer_privacy_requests
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_privacy_requests_platform_access ON customer_privacy_requests;
CREATE POLICY customer_privacy_requests_platform_access ON customer_privacy_requests
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE customer_privacy_retention_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_privacy_retention_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_privacy_retention_tenant_select
  ON customer_privacy_retention_items;
CREATE POLICY customer_privacy_retention_tenant_select ON customer_privacy_retention_items
  FOR SELECT USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_privacy_retention_platform_access
  ON customer_privacy_retention_items;
CREATE POLICY customer_privacy_retention_platform_access ON customer_privacy_retention_items
  FOR ALL USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

REVOKE ALL ON FUNCTION app.enforce_legal_document_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_customer_legal_consent() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.customer_erasure_authorized(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.enforce_customer_account_privacy_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protect_audit_log_or_customer_erasure() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.prevent_customer_secret_delete_unless_erasing() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.protect_referral_code_or_customer_erasure() FROM PUBLIC;

COMMIT;
