BEGIN;

CREATE TABLE IF NOT EXISTS interaction_sensitive_words (
  id uuid PRIMARY KEY,
  scope_type text NOT NULL,
  tenant_id uuid,
  term text NOT NULL,
  normalized_term text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by uuid,
  CONSTRAINT interaction_sensitive_words_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_sensitive_words_scope_check CHECK (
    app.valid_content_scope(scope_type, tenant_id)
  ),
  CONSTRAINT interaction_sensitive_words_term_check CHECK (
    char_length(btrim(term)) BETWEEN 2 AND 64
    AND char_length(normalized_term) BETWEEN 2 AND 64
    AND normalized_term = lower(btrim(term))
  ),
  CONSTRAINT interaction_sensitive_words_status_check CHECK (
    status IN ('active', 'disabled')
  ),
  CONSTRAINT interaction_sensitive_words_timestamp_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS interaction_sensitive_words_scope_term_unique_idx
  ON interaction_sensitive_words (
    scope_type,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    normalized_term
  );

CREATE INDEX IF NOT EXISTS interaction_sensitive_words_active_idx
  ON interaction_sensitive_words (scope_type, tenant_id, normalized_term)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS interaction_sensitive_words_set_updated_at
  ON interaction_sensitive_words;
CREATE TRIGGER interaction_sensitive_words_set_updated_at
BEFORE UPDATE ON interaction_sensitive_words
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE OR REPLACE FUNCTION app.freeze_interaction_sensitive_word_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.scope_type <> OLD.scope_type
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.normalized_term <> OLD.normalized_term
  THEN
    RAISE EXCEPTION 'sensitive-word scope and normalized term are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_sensitive_words_freeze_scope
  ON interaction_sensitive_words;
CREATE TRIGGER interaction_sensitive_words_freeze_scope
BEFORE UPDATE ON interaction_sensitive_words
FOR EACH ROW EXECUTE FUNCTION app.freeze_interaction_sensitive_word_scope();

DROP TRIGGER IF EXISTS interaction_sensitive_words_prevent_delete
  ON interaction_sensitive_words;
CREATE TRIGGER interaction_sensitive_words_prevent_delete
BEFORE DELETE ON interaction_sensitive_words
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

CREATE TABLE IF NOT EXISTS interaction_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  episode_id uuid,
  account_id uuid NOT NULL,
  parent_id uuid,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'visible',
  sensitive_match_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  moderated_at timestamptz,
  moderated_by uuid,
  moderated_by_type text,
  moderation_reason text,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_type text,
  delete_reason text,
  restore_until timestamptz,
  restored_at timestamptz,
  restore_count smallint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT interaction_comments_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_comments_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_comments_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_comments_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_comments_parent_fk FOREIGN KEY (parent_id)
    REFERENCES interaction_comments (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_comments_parent_self_check CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT interaction_comments_body_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 2000
  ),
  CONSTRAINT interaction_comments_status_check CHECK (
    status IN ('visible', 'pending', 'hidden', 'deleted')
  ),
  CONSTRAINT interaction_comments_matches_check CHECK (
    cardinality(sensitive_match_ids) <= 20
  ),
  CONSTRAINT interaction_comments_moderation_check CHECK (
    (
      moderated_at IS NULL AND moderated_by IS NULL
      AND moderated_by_type IS NULL AND moderation_reason IS NULL
    )
    OR (
      moderated_at IS NOT NULL AND moderated_by IS NOT NULL
      AND moderated_by_type IN ('tenant_staff', 'platform_staff')
      AND moderation_reason IS NOT NULL
      AND char_length(btrim(moderation_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT interaction_comments_delete_check CHECK (
    (
      status <> 'deleted'
      AND deleted_at IS NULL AND deleted_by IS NULL AND deleted_by_type IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      status = 'deleted'
      AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND deleted_by_type IN ('user', 'tenant_staff', 'platform_staff')
      AND (deleted_by_type <> 'user' OR deleted_by = account_id)
      AND (
        deleted_by_type = 'user'
        OR (
          moderated_at IS NOT NULL
          AND moderated_by = deleted_by
          AND moderated_by_type = deleted_by_type
        )
      )
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000
      AND restore_until = deleted_at + interval '30 days'
    )
  ),
  CONSTRAINT interaction_comments_restore_check CHECK (
    restore_count BETWEEN 0 AND 1
    AND (
      (restore_count = 0 AND restored_at IS NULL)
      OR (restore_count = 1 AND restored_at IS NOT NULL)
    )
  ),
  CONSTRAINT interaction_comments_version_check CHECK (version >= 0),
  CONSTRAINT interaction_comments_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS interaction_comments_target_visible_idx
  ON interaction_comments (tenant_id, drama_id, episode_id, created_at DESC, id)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS interaction_comments_parent_idx
  ON interaction_comments (tenant_id, parent_id, created_at, id)
  WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interaction_comments_moderation_idx
  ON interaction_comments (tenant_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS interaction_comments_restore_idx
  ON interaction_comments (tenant_id, restore_until, id)
  WHERE status = 'deleted';

CREATE TABLE IF NOT EXISTS interaction_bullet_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  drama_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  account_id uuid NOT NULL,
  position_ms integer NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'visible',
  sensitive_match_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  moderated_at timestamptz,
  moderated_by uuid,
  moderated_by_type text,
  moderation_reason text,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_type text,
  delete_reason text,
  restore_until timestamptz,
  restored_at timestamptz,
  restore_count smallint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT interaction_bullet_comments_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_bullet_comments_drama_fk FOREIGN KEY (drama_id)
    REFERENCES dramas (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_bullet_comments_episode_fk FOREIGN KEY (episode_id)
    REFERENCES episodes (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_bullet_comments_account_fk FOREIGN KEY (tenant_id, account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_bullet_comments_position_check CHECK (
    position_ms BETWEEN 0 AND 86400000
  ),
  CONSTRAINT interaction_bullet_comments_body_check CHECK (
    char_length(btrim(body)) BETWEEN 1 AND 200
  ),
  CONSTRAINT interaction_bullet_comments_status_check CHECK (
    status IN ('visible', 'pending', 'hidden', 'deleted')
  ),
  CONSTRAINT interaction_bullet_comments_matches_check CHECK (
    cardinality(sensitive_match_ids) <= 20
  ),
  CONSTRAINT interaction_bullet_comments_moderation_check CHECK (
    (
      moderated_at IS NULL AND moderated_by IS NULL
      AND moderated_by_type IS NULL AND moderation_reason IS NULL
    )
    OR (
      moderated_at IS NOT NULL AND moderated_by IS NOT NULL
      AND moderated_by_type IN ('tenant_staff', 'platform_staff')
      AND moderation_reason IS NOT NULL
      AND char_length(btrim(moderation_reason)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT interaction_bullet_comments_delete_check CHECK (
    (
      status <> 'deleted'
      AND deleted_at IS NULL AND deleted_by IS NULL AND deleted_by_type IS NULL
      AND delete_reason IS NULL AND restore_until IS NULL
    )
    OR (
      status = 'deleted'
      AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL
      AND deleted_by_type IN ('user', 'tenant_staff', 'platform_staff')
      AND (deleted_by_type <> 'user' OR deleted_by = account_id)
      AND (
        deleted_by_type = 'user'
        OR (
          moderated_at IS NOT NULL
          AND moderated_by = deleted_by
          AND moderated_by_type = deleted_by_type
        )
      )
      AND delete_reason IS NOT NULL
      AND char_length(btrim(delete_reason)) BETWEEN 1 AND 1000
      AND restore_until = deleted_at + interval '30 days'
    )
  ),
  CONSTRAINT interaction_bullet_comments_restore_check CHECK (
    restore_count BETWEEN 0 AND 1
    AND (
      (restore_count = 0 AND restored_at IS NULL)
      OR (restore_count = 1 AND restored_at IS NOT NULL)
    )
  ),
  CONSTRAINT interaction_bullet_comments_version_check CHECK (version >= 0),
  CONSTRAINT interaction_bullet_comments_timestamp_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS interaction_bullet_target_visible_idx
  ON interaction_bullet_comments (tenant_id, episode_id, position_ms, id)
  WHERE status = 'visible';
CREATE INDEX IF NOT EXISTS interaction_bullet_moderation_idx
  ON interaction_bullet_comments (tenant_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS interaction_bullet_restore_idx
  ON interaction_bullet_comments (tenant_id, restore_until, id)
  WHERE status = 'deleted';

CREATE TABLE IF NOT EXISTS interaction_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  reporter_account_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reason_category text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  reviewed_at timestamptz,
  reviewed_by uuid,
  reviewed_by_type text,
  resolution text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT interaction_reports_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_reports_account_fk FOREIGN KEY (tenant_id, reporter_account_id)
    REFERENCES customer_accounts (tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_reports_target_type_check CHECK (
    target_type IN ('comment', 'bullet_comment')
  ),
  CONSTRAINT interaction_reports_reason_check CHECK (
    reason_category IN ('abuse', 'copyright', 'harassment', 'illegal', 'spam', 'other')
  ),
  CONSTRAINT interaction_reports_details_check CHECK (
    details IS NULL OR char_length(btrim(details)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT interaction_reports_status_check CHECK (
    status IN ('open', 'reviewing', 'resolved', 'rejected')
  ),
  CONSTRAINT interaction_reports_review_check CHECK (
    (
      status IN ('open', 'reviewing')
      AND reviewed_at IS NULL AND reviewed_by IS NULL
      AND reviewed_by_type IS NULL AND resolution IS NULL
    )
    OR (
      status IN ('resolved', 'rejected')
      AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
      AND reviewed_by_type IN ('tenant_staff', 'platform_staff')
      AND resolution IS NOT NULL
      AND char_length(btrim(resolution)) BETWEEN 1 AND 1000
    )
  ),
  CONSTRAINT interaction_reports_version_check CHECK (version >= 0),
  CONSTRAINT interaction_reports_timestamp_check CHECK (updated_at >= created_at),
  CONSTRAINT interaction_reports_reporter_target_unique UNIQUE (
    tenant_id, reporter_account_id, target_type, target_id
  )
);

CREATE INDEX IF NOT EXISTS interaction_reports_moderation_idx
  ON interaction_reports (tenant_id, status, created_at, id);
CREATE INDEX IF NOT EXISTS interaction_reports_target_idx
  ON interaction_reports (tenant_id, target_type, target_id);

CREATE TABLE IF NOT EXISTS interaction_moderation_actions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid NOT NULL,
  reason text NOT NULL,
  before_status text NOT NULL,
  after_status text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT interaction_moderation_actions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT interaction_moderation_actions_target_type_check CHECK (
    target_type IN ('comment', 'bullet_comment', 'report')
  ),
  CONSTRAINT interaction_moderation_actions_action_check CHECK (
    action IN ('approve', 'hide', 'delete', 'restore', 'resolve', 'reject')
  ),
  CONSTRAINT interaction_moderation_actions_transition_check CHECK (
    (
      target_type IN ('comment', 'bullet_comment')
      AND (
        (action = 'approve' AND before_status IN ('pending', 'hidden') AND after_status = 'visible')
        OR (action = 'hide' AND before_status IN ('visible', 'pending') AND after_status = 'hidden')
        OR (action = 'delete' AND before_status IN ('visible', 'pending', 'hidden') AND after_status = 'deleted')
        OR (action = 'restore' AND before_status = 'deleted' AND after_status = 'hidden')
      )
    )
    OR (
      target_type = 'report'
      AND before_status IN ('open', 'reviewing')
      AND (
        (action = 'resolve' AND after_status = 'resolved')
        OR (action = 'reject' AND after_status = 'rejected')
      )
    )
  ),
  CONSTRAINT interaction_moderation_actions_actor_check CHECK (
    actor_type IN ('tenant_staff', 'platform_staff')
  ),
  CONSTRAINT interaction_moderation_actions_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT interaction_moderation_actions_status_check CHECK (
    char_length(before_status) BETWEEN 3 AND 32
    AND char_length(after_status) BETWEEN 3 AND 32
  ),
  CONSTRAINT interaction_moderation_actions_request_check CHECK (
    char_length(request_id) BETWEEN 8 AND 128
  ),
  CONSTRAINT interaction_moderation_actions_request_target_unique UNIQUE (
    tenant_id, target_type, target_id, request_id
  )
);

CREATE INDEX IF NOT EXISTS interaction_moderation_actions_target_idx
  ON interaction_moderation_actions (
    tenant_id, target_type, target_id, created_at DESC, id
  );

CREATE OR REPLACE FUNCTION app.enforce_interaction_comment_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  parent_record interaction_comments%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent_record
  FROM interaction_comments
  WHERE id = NEW.parent_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR parent_record.parent_id IS NOT NULL
    OR parent_record.tenant_id <> NEW.tenant_id
    OR parent_record.drama_id <> NEW.drama_id
    OR parent_record.episode_id IS DISTINCT FROM NEW.episode_id
    OR parent_record.status <> 'visible'
  THEN
    RAISE EXCEPTION 'comment replies must target a visible first-level parent in the same tenant and content scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_comments_enforce_parent ON interaction_comments;
CREATE TRIGGER interaction_comments_enforce_parent
BEFORE INSERT OR UPDATE OF parent_id, tenant_id, drama_id, episode_id
ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_comment_parent();

CREATE OR REPLACE FUNCTION app.enforce_interaction_episode_drama()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  actual_drama_id uuid;
BEGIN
  IF NEW.episode_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT drama_id INTO actual_drama_id
  FROM episodes
  WHERE id = NEW.episode_id
  FOR KEY SHARE;
  IF actual_drama_id IS NULL OR actual_drama_id <> NEW.drama_id THEN
    RAISE EXCEPTION 'episode does not belong to the supplied drama'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_interaction_content_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenants AS tenant
    INNER JOIN customer_accounts AS account
      ON account.tenant_id = tenant.id
     AND account.id = NEW.account_id
     AND account.status = 'active'
    INNER JOIN dramas AS drama ON drama.id = NEW.drama_id
    WHERE tenant.id = NEW.tenant_id
      AND tenant.status = 'active'
      AND tenant.expires_at > statement_timestamp()
      AND tenant.user_site_enabled
      AND drama.status = 'published'
      AND drama.deleted_at IS NULL
      AND (drama.release_at IS NULL OR drama.release_at <= statement_timestamp())
      AND (drama.unpublish_at IS NULL OR drama.unpublish_at > statement_timestamp())
      AND (
        (drama.owner_type = 'tenant' AND drama.owner_tenant_id = NEW.tenant_id)
        OR (
          drama.owner_type = 'platform'
          AND EXISTS (
            SELECT 1
            FROM content_license_items AS item
            INNER JOIN content_licenses AS license
              ON license.id = item.license_id
             AND license.tenant_id = item.tenant_id
            WHERE item.tenant_id = NEW.tenant_id
              AND item.drama_id = drama.id
              AND license.status IN ('scheduled', 'active')
              AND license.starts_at <= statement_timestamp()
              AND license.expires_at > statement_timestamp()
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'interaction content is not published in the tenant scope'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.episode_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM episodes AS episode
    WHERE episode.id = NEW.episode_id
      AND episode.drama_id = NEW.drama_id
      AND episode.status = 'published'
      AND episode.deleted_at IS NULL
      AND (episode.release_at IS NULL OR episode.release_at <= statement_timestamp())
      AND (episode.unpublish_at IS NULL OR episode.unpublish_at > statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'interaction episode is not currently published'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_comments_enforce_episode_drama
  ON interaction_comments;
CREATE TRIGGER interaction_comments_enforce_episode_drama
BEFORE INSERT OR UPDATE OF drama_id, episode_id ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_episode_drama();

DROP TRIGGER IF EXISTS interaction_bullet_enforce_episode_drama
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_enforce_episode_drama
BEFORE INSERT OR UPDATE OF drama_id, episode_id ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_episode_drama();

DROP TRIGGER IF EXISTS interaction_comments_enforce_content_scope
  ON interaction_comments;
CREATE TRIGGER interaction_comments_enforce_content_scope
BEFORE INSERT OR UPDATE OF tenant_id, drama_id, episode_id, account_id
ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_content_scope();

DROP TRIGGER IF EXISTS interaction_bullet_enforce_content_scope
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_enforce_content_scope
BEFORE INSERT OR UPDATE OF tenant_id, drama_id, episode_id, account_id
ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_content_scope();

CREATE OR REPLACE FUNCTION app.freeze_interaction_comment_structure()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.drama_id <> OLD.drama_id
    OR NEW.episode_id IS DISTINCT FROM OLD.episode_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.body <> OLD.body
    OR NEW.sensitive_match_ids IS DISTINCT FROM OLD.sensitive_match_ids
  THEN
    RAISE EXCEPTION 'comment identity, content, body, and moderation matches are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.freeze_interaction_bullet_structure()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.drama_id <> OLD.drama_id
    OR NEW.episode_id <> OLD.episode_id
    OR NEW.account_id <> OLD.account_id
    OR NEW.position_ms <> OLD.position_ms
    OR NEW.body <> OLD.body
    OR NEW.sensitive_match_ids IS DISTINCT FROM OLD.sensitive_match_ids
  THEN
    RAISE EXCEPTION 'bullet identity, position, body, and moderation matches are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.freeze_interaction_report_structure()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.reporter_account_id <> OLD.reporter_account_id
    OR NEW.target_type <> OLD.target_type
    OR NEW.target_id <> OLD.target_id
    OR NEW.reason_category <> OLD.reason_category
    OR NEW.details IS DISTINCT FROM OLD.details
  THEN
    RAISE EXCEPTION 'report target, reporter, and reason snapshot are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_comments_freeze_structure ON interaction_comments;
CREATE TRIGGER interaction_comments_freeze_structure
BEFORE UPDATE ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.freeze_interaction_comment_structure();

DROP TRIGGER IF EXISTS interaction_bullet_freeze_structure
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_freeze_structure
BEFORE UPDATE ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.freeze_interaction_bullet_structure();

DROP TRIGGER IF EXISTS interaction_reports_freeze_structure ON interaction_reports;
CREATE TRIGGER interaction_reports_freeze_structure
BEFORE UPDATE ON interaction_reports
FOR EACH ROW EXECUTE FUNCTION app.freeze_interaction_report_structure();

CREATE OR REPLACE FUNCTION app.enforce_interaction_restore_window()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    IF OLD.restore_count <> 0 OR OLD.restore_until < statement_timestamp() THEN
      RAISE EXCEPTION 'interaction can no longer be restored'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'hidden' THEN
      RAISE EXCEPTION 'restored interaction must remain hidden until approved'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.moderated_at IS NULL
      OR NEW.moderated_by IS NULL
      OR NEW.moderated_by_type NOT IN ('tenant_staff', 'platform_staff')
      OR NEW.moderation_reason IS NULL
    THEN
      RAISE EXCEPTION 'restoration requires an attributable staff moderation decision'
        USING ERRCODE = '23514';
    END IF;
    NEW.deleted_at := NULL;
    NEW.deleted_by := NULL;
    NEW.deleted_by_type := NULL;
    NEW.delete_reason := NULL;
    NEW.restore_until := NULL;
    NEW.restore_count := 1;
    NEW.restored_at := statement_timestamp();
  END IF;
  IF NOT (OLD.status = 'deleted' AND NEW.status <> 'deleted')
    AND (
      NEW.restore_count <> OLD.restore_count
      OR NEW.restored_at IS DISTINCT FROM OLD.restored_at
    )
  THEN
    RAISE EXCEPTION 'interaction restore history can only change during restoration'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.restore_count = 1 AND (
    NEW.restore_count <> 1 OR NEW.restored_at IS DISTINCT FROM OLD.restored_at
  ) THEN
    RAISE EXCEPTION 'interaction restore history is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'deleted' AND NEW.status = 'deleted' AND (
    NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
    OR NEW.deleted_by_type IS DISTINCT FROM OLD.deleted_by_type
    OR NEW.delete_reason IS DISTINCT FROM OLD.delete_reason
    OR NEW.restore_until IS DISTINCT FROM OLD.restore_until
  ) THEN
    RAISE EXCEPTION 'interaction deletion snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_interaction_moderation_action()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.actor_type = 'tenant_staff' AND NOT EXISTS (
    SELECT 1 FROM tenant_staff
    WHERE id = NEW.actor_id AND tenant_id = NEW.tenant_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'tenant moderation actor is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.actor_type = 'platform_staff' AND NOT EXISTS (
    SELECT 1 FROM platform_staff
    WHERE id = NEW.actor_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'platform moderation actor is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.target_type = 'comment' AND NOT EXISTS (
    SELECT 1 FROM interaction_comments
    WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id
      AND status = NEW.after_status
  ) THEN
    RAISE EXCEPTION 'comment moderation action does not match its target state'
      USING ERRCODE = '23514';
  ELSIF NEW.target_type = 'bullet_comment' AND NOT EXISTS (
    SELECT 1 FROM interaction_bullet_comments
    WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id
      AND status = NEW.after_status
  ) THEN
    RAISE EXCEPTION 'bullet moderation action does not match its target state'
      USING ERRCODE = '23514';
  ELSIF NEW.target_type = 'report' AND NOT EXISTS (
    SELECT 1 FROM interaction_reports
    WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id
      AND status = NEW.after_status
  ) THEN
    RAISE EXCEPTION 'report moderation action does not match its target state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_moderation_actions_enforce_target
  ON interaction_moderation_actions;
CREATE TRIGGER interaction_moderation_actions_enforce_target
BEFORE INSERT ON interaction_moderation_actions
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_moderation_action();

DROP TRIGGER IF EXISTS interaction_comments_enforce_restore
  ON interaction_comments;
CREATE TRIGGER interaction_comments_enforce_restore
BEFORE UPDATE ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_restore_window();

DROP TRIGGER IF EXISTS interaction_bullet_enforce_restore
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_enforce_restore
BEFORE UPDATE ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_restore_window();

CREATE OR REPLACE FUNCTION app.enforce_interaction_report_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM tenants AS tenant
    INNER JOIN customer_accounts AS account
      ON account.tenant_id = tenant.id
     AND account.id = NEW.reporter_account_id
     AND account.status = 'active'
    WHERE tenant.id = NEW.tenant_id
      AND tenant.status = 'active'
      AND tenant.expires_at > statement_timestamp()
      AND tenant.user_site_enabled
  ) THEN
    RAISE EXCEPTION 'reporter or customer site is unavailable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.target_type = 'comment' THEN
    IF NOT EXISTS (
      SELECT 1 FROM interaction_comments
      WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id AND status = 'visible'
    ) THEN
      RAISE EXCEPTION 'reported comment is outside the tenant scope'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM interaction_bullet_comments
    WHERE id = NEW.target_id AND tenant_id = NEW.tenant_id AND status = 'visible'
  ) THEN
    RAISE EXCEPTION 'reported bullet comment is outside the tenant scope'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS interaction_reports_enforce_target ON interaction_reports;
CREATE TRIGGER interaction_reports_enforce_target
BEFORE INSERT OR UPDATE OF tenant_id, target_type, target_id
ON interaction_reports
FOR EACH ROW EXECUTE FUNCTION app.enforce_interaction_report_target();

DROP TRIGGER IF EXISTS interaction_comments_set_updated_at ON interaction_comments;
CREATE TRIGGER interaction_comments_set_updated_at
BEFORE UPDATE ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
DROP TRIGGER IF EXISTS interaction_bullet_comments_set_updated_at
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_comments_set_updated_at
BEFORE UPDATE ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
DROP TRIGGER IF EXISTS interaction_reports_set_updated_at ON interaction_reports;
CREATE TRIGGER interaction_reports_set_updated_at
BEFORE UPDATE ON interaction_reports
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

DROP TRIGGER IF EXISTS interaction_moderation_actions_prevent_update
  ON interaction_moderation_actions;
CREATE TRIGGER interaction_moderation_actions_prevent_update
BEFORE UPDATE OR DELETE ON interaction_moderation_actions
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

DROP TRIGGER IF EXISTS interaction_comments_prevent_delete ON interaction_comments;
CREATE TRIGGER interaction_comments_prevent_delete
BEFORE DELETE ON interaction_comments
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

DROP TRIGGER IF EXISTS interaction_bullet_comments_prevent_delete
  ON interaction_bullet_comments;
CREATE TRIGGER interaction_bullet_comments_prevent_delete
BEFORE DELETE ON interaction_bullet_comments
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

DROP TRIGGER IF EXISTS interaction_reports_prevent_delete ON interaction_reports;
CREATE TRIGGER interaction_reports_prevent_delete
BEFORE DELETE ON interaction_reports
FOR EACH ROW EXECUTE FUNCTION app.prevent_row_mutation();

ALTER TABLE interaction_sensitive_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_sensitive_words FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_sensitive_words_tenant_read
  ON interaction_sensitive_words;
CREATE POLICY interaction_sensitive_words_tenant_read ON interaction_sensitive_words
  FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    OR (scope_type = 'platform' AND app.current_tenant_id() IS NOT NULL)
  );
DROP POLICY IF EXISTS interaction_sensitive_words_tenant_write
  ON interaction_sensitive_words;
CREATE POLICY interaction_sensitive_words_tenant_write ON interaction_sensitive_words
  FOR ALL
  USING (scope_type = 'tenant' AND tenant_id = app.current_tenant_id())
  WITH CHECK (scope_type = 'tenant' AND tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS interaction_sensitive_words_platform_access
  ON interaction_sensitive_words;
CREATE POLICY interaction_sensitive_words_platform_access ON interaction_sensitive_words
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE interaction_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_comments_tenant_isolation ON interaction_comments;
CREATE POLICY interaction_comments_tenant_isolation ON interaction_comments
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS interaction_comments_platform_access ON interaction_comments;
CREATE POLICY interaction_comments_platform_access ON interaction_comments
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE interaction_bullet_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_bullet_comments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_bullet_comments_tenant_isolation
  ON interaction_bullet_comments;
CREATE POLICY interaction_bullet_comments_tenant_isolation
  ON interaction_bullet_comments
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS interaction_bullet_comments_platform_access
  ON interaction_bullet_comments;
CREATE POLICY interaction_bullet_comments_platform_access
  ON interaction_bullet_comments
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE interaction_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_reports_tenant_isolation ON interaction_reports;
CREATE POLICY interaction_reports_tenant_isolation ON interaction_reports
  FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS interaction_reports_platform_access ON interaction_reports;
CREATE POLICY interaction_reports_platform_access ON interaction_reports
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

ALTER TABLE interaction_moderation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_moderation_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_moderation_actions_tenant_isolation
  ON interaction_moderation_actions;
CREATE POLICY interaction_moderation_actions_tenant_isolation
  ON interaction_moderation_actions
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS interaction_moderation_actions_tenant_insert
  ON interaction_moderation_actions;
CREATE POLICY interaction_moderation_actions_tenant_insert
  ON interaction_moderation_actions
  FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND actor_type = 'tenant_staff'
  );
DROP POLICY IF EXISTS interaction_moderation_actions_platform_access
  ON interaction_moderation_actions;
CREATE POLICY interaction_moderation_actions_platform_access
  ON interaction_moderation_actions
  FOR ALL
  USING (app.has_platform_access(current_user))
  WITH CHECK (app.has_platform_access(current_user));

COMMIT;
