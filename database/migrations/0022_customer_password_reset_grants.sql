BEGIN;

-- Reuse the existing single-use grant columns, while binding reset grants to
-- their distinct purpose. Application tokens also use a separate `prg_`
-- prefix, so registration and reset capabilities cannot be interchanged.
ALTER TABLE customer_otp_challenges
  DROP CONSTRAINT IF EXISTS customer_otp_verification_grant_check;

ALTER TABLE customer_otp_challenges
  ADD CONSTRAINT customer_otp_verification_grant_check CHECK (
    (
      verification_grant_hash IS NULL
      AND verification_grant_expires_at IS NULL
      AND verification_grant_consumed_at IS NULL
    )
    OR (
      account_id IS NULL
      AND purpose IN ('verify_email', 'verify_phone', 'password_reset')
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

COMMENT ON COLUMN customer_otp_challenges.verification_grant_hash IS
  'Versioned SHA-256 digest of a short-lived, purpose-bound, single-use contact verification or password-reset grant.';

COMMIT;
