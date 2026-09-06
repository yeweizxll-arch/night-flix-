BEGIN;

ALTER TABLE tenant_communication_configs DROP CONSTRAINT tenant_communication_configs_provider_check;
ALTER TABLE tenant_communication_configs ADD CONSTRAINT tenant_communication_configs_provider_check CHECK (
  (channel = 'email' AND provider IN ('resend', 'qq_smtp')) OR (channel = 'sms' AND provider = 'twilio')
);
ALTER TABLE tenant_communication_secrets DROP CONSTRAINT tenant_communication_secrets_provider_check;
ALTER TABLE tenant_communication_secrets ADD CONSTRAINT tenant_communication_secrets_provider_check CHECK (
  (channel = 'email' AND provider IN ('resend', 'qq_smtp')) OR (channel = 'sms' AND provider = 'twilio')
);

CREATE OR REPLACE FUNCTION app.freeze_communication_config_identity()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.channel <> OLD.channel
    OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'communication configuration identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.provider <> OLD.provider AND (
    NEW.status <> 'disabled' OR NEW.last_test_status IS NOT NULL
    OR NEW.last_tested_at IS NOT NULL OR NEW.last_test_error IS NOT NULL
    OR NEW.version <> OLD.version + 1
  ) THEN
    RAISE EXCEPTION 'provider change requires disabled untested new version' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION app.enforce_communication_secret_binding()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenant_communication_configs AS config
    WHERE config.id = NEW.config_id AND config.tenant_id = NEW.tenant_id
      AND config.channel = NEW.channel AND config.provider = NEW.provider
  ) THEN
    RAISE EXCEPTION 'communication secret binding is invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.config_id <> OLD.config_id OR NEW.tenant_id <> OLD.tenant_id
    OR NEW.channel <> OLD.channel OR NEW.created_at <> OLD.created_at
  ) THEN
    RAISE EXCEPTION 'communication secret identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.provider <> OLD.provider AND NOT EXISTS (
    SELECT 1 FROM tenant_communication_configs AS config
    WHERE config.id = NEW.config_id AND config.status = 'disabled' AND config.last_test_status IS NULL
  ) THEN
    RAISE EXCEPTION 'provider change requires disabled untested configuration' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

COMMIT;
