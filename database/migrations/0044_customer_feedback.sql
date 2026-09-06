BEGIN;
CREATE TABLE IF NOT EXISTS customer_feedback (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  locale text NOT NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  reply text CHECK (reply IS NULL OR char_length(btrim(reply)) BETWEEN 1 AND 2000),
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id),
  CHECK ((reply IS NULL) = (replied_at IS NULL))
);
CREATE INDEX IF NOT EXISTS customer_feedback_inbox ON customer_feedback(tenant_id, created_at DESC, id);
ALTER TABLE customer_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_feedback_tenant ON customer_feedback;
CREATE POLICY customer_feedback_tenant ON customer_feedback FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
DROP POLICY IF EXISTS customer_feedback_erasure ON customer_feedback;
CREATE POLICY customer_feedback_erasure ON customer_feedback FOR ALL
  USING (app.has_platform_access(current_user)) WITH CHECK (app.has_platform_access(current_user));
-- Tenant staff may deliver only an existing reply to its original author.
-- No generic tenant INSERT policy is added to the system inbox.
DROP POLICY IF EXISTS customer_inbox_feedback_reply ON customer_inbox_messages;
CREATE POLICY customer_inbox_feedback_reply ON customer_inbox_messages FOR INSERT
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND category = 'transactional'
    AND source_type = 'system' AND campaign_id IS NULL AND deep_link IS NULL
    AND status = 'unread' AND read_at IS NULL
    AND EXISTS (SELECT 1 FROM customer_feedback AS f
      WHERE f.id = customer_inbox_messages.id
        AND f.tenant_id = customer_inbox_messages.tenant_id
        AND f.account_id = customer_inbox_messages.account_id
        AND f.locale = customer_inbox_messages.locale
        AND f.replied_at IS NOT NULL AND f.reply = customer_inbox_messages.body
        AND customer_inbox_messages.title = CASE WHEN f.locale LIKE 'zh%'
          THEN '客服回复' ELSE 'Support reply' END)
  );
COMMIT;
