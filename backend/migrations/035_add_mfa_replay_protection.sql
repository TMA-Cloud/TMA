-- Track the last TOTP time step accepted for each user, so a code that has
-- already been used cannot be replayed while it is still inside the
-- verification window (RFC 6238 section 5.2 requires exactly this).
-- NULL means no code has been accepted yet for the current secret.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_time_step BIGINT;
