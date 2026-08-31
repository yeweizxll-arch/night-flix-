BEGIN;

ALTER TABLE notification_provider_configs
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production';

ALTER TABLE notification_provider_configs
  DROP CONSTRAINT IF EXISTS notification_provider_configs_environment_check;
ALTER TABLE notification_provider_configs
  ADD CONSTRAINT notification_provider_configs_environment_check CHECK (
    (provider = 'apns' AND environment IN ('production', 'sandbox'))
    OR (provider = 'fcm' AND environment = 'production')
  );

CREATE OR REPLACE FUNCTION app.freeze_notification_provider_config_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.provider <> OLD.provider OR NEW.created_by <> OLD.created_by
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'notification provider configuration identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.environment IS DISTINCT FROM OLD.environment
    AND NEW.credentials_ciphertext IS NOT DISTINCT FROM OLD.credentials_ciphertext
  THEN
    RAISE EXCEPTION 'notification provider environment requires new credentials'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.credentials_ciphertext IS DISTINCT FROM OLD.credentials_ciphertext
    OR NEW.key_version IS DISTINCT FROM OLD.key_version
    OR NEW.environment IS DISTINCT FROM OLD.environment
  THEN
    IF NEW.version <> OLD.version + 1 OR NEW.status <> 'disabled'
      OR NEW.last_test_status IS NOT NULL OR NEW.last_tested_at IS NOT NULL
      OR NEW.last_test_error IS NOT NULL
    THEN
      RAISE EXCEPTION 'notification provider credential replacement must reset test state'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER TABLE notification_provider_configs
  DROP CONSTRAINT IF EXISTS notification_provider_configs_test_check;
ALTER TABLE notification_provider_configs
  ADD CONSTRAINT notification_provider_configs_test_check CHECK (
    (last_test_status IS NULL AND last_tested_at IS NULL AND last_test_error IS NULL)
    OR (last_test_status = 'passed' AND last_tested_at IS NOT NULL AND last_test_error IS NULL)
    OR (
      last_test_status = 'failed' AND last_tested_at IS NOT NULL
      AND last_test_error IS NOT NULL
      AND last_test_error IN (
        'provider_adapter_unavailable',
        'secret_authentication_failed',
        'external_provider_failure',
        'provider_authentication_failed',
        'provider_rejected',
        'provider_temporarily_unavailable',
        'provider_timeout',
        'unexpected_provider_response'
      )
    )
  );

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_sent_check;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_sent_check CHECK (
    (
      status = 'sent' AND sent_at IS NOT NULL AND last_error IS NULL
      AND (
        (channel = 'in_app' AND provider_message_id IS NULL)
        OR (
          channel = 'push' AND provider_message_id IS NOT NULL
          AND char_length(provider_message_id) BETWEEN 1 AND 500
          AND provider_message_id ~ '^[-A-Za-z0-9._:@/%+=]+$'
        )
      )
    )
    OR (status <> 'sent' AND sent_at IS NULL AND provider_message_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS outbox_events_transactional_notification_idx
  ON outbox_events (created_at, id)
  WHERE event_type IN (
    'OrderPendingPaymentCreated',
    'PaymentSucceeded',
    'PaymentRefundSucceeded',
    'PaymentRefundFailed',
    'CustomerPasswordChanged',
    'CustomerPasswordReset',
    'CustomerDeviceRevoked'
  );

COMMIT;
