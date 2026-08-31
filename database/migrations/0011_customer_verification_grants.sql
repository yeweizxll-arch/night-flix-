BEGIN;

ALTER TABLE customer_otp_challenges
  ADD COLUMN IF NOT EXISTS verification_grant_hash text,
  ADD COLUMN IF NOT EXISTS verification_grant_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_grant_consumed_at timestamptz;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_otp_verification_grant_check'
      AND conrelid = 'customer_otp_challenges'::regclass
  ) THEN
    ALTER TABLE customer_otp_challenges
      ADD CONSTRAINT customer_otp_verification_grant_check CHECK (
        (
          verification_grant_hash IS NULL
          AND verification_grant_expires_at IS NULL
          AND verification_grant_consumed_at IS NULL
        )
        OR (
          account_id IS NULL
          AND purpose IN ('verify_email', 'verify_phone')
          AND consumed_at IS NOT NULL
          AND verification_grant_hash ~ '^sha256\$[A-Za-z0-9_-]{43}$'
          AND verification_grant_expires_at > consumed_at
          AND (
            verification_grant_consumed_at IS NULL
            OR (
              verification_grant_consumed_at >= consumed_at
              AND verification_grant_consumed_at < verification_grant_expires_at
            )
          )
        )
      );
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS customer_otp_verification_grant_hash_unique_idx
  ON customer_otp_challenges (verification_grant_hash)
  WHERE verification_grant_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS customer_otp_verification_grant_expiry_idx
  ON customer_otp_challenges (verification_grant_expires_at, id)
  WHERE verification_grant_hash IS NOT NULL
    AND verification_grant_consumed_at IS NULL;

COMMENT ON COLUMN customer_otp_challenges.verification_grant_hash IS
  'Versioned SHA-256 digest of a short-lived single-use registration verification grant.';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_accounts_email_must_be_verified_check'
      AND conrelid = 'customer_accounts'::regclass
  ) THEN
    ALTER TABLE customer_accounts
      ADD CONSTRAINT customer_accounts_email_must_be_verified_check CHECK (
        (email IS NULL AND email_verified_at IS NULL)
        OR (email IS NOT NULL AND email_verified_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customer_accounts_phone_must_be_verified_check'
      AND conrelid = 'customer_accounts'::regclass
  ) THEN
    ALTER TABLE customer_accounts
      ADD CONSTRAINT customer_accounts_phone_must_be_verified_check CHECK (
        (phone IS NULL AND phone_verified_at IS NULL)
        OR (phone IS NOT NULL AND phone_verified_at IS NOT NULL)
      );
  END IF;
END
$migration$;

COMMENT ON CONSTRAINT customer_accounts_email_must_be_verified_check
  ON customer_accounts IS
  'Every stored email contact must already have an atomic verification timestamp.';
COMMENT ON CONSTRAINT customer_accounts_phone_must_be_verified_check
  ON customer_accounts IS
  'Every stored phone contact must already have an atomic verification timestamp.';

COMMIT;
