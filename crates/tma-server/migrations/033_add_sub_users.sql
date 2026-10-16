-- Sub-users: a normal user (the account owner) can create additional login
-- identities that share the owner's files, folders and storage quota.
--
-- Everything a sub-user touches belongs to the owner, so `parent_user_id` is
-- the account boundary: the effective owner of a row is
-- COALESCE(parent_user_id, id). Sub-users cannot own sub-users themselves,
-- which the trigger further down enforces.

ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;

-- What a sub-user is allowed to do, as an explicit set of grants rather than a
-- coarse role: the owner ticks exactly the capabilities each person needs.
-- Owners hold no entries here because they are never checked against it — an
-- account owner implicitly has every capability over their own account.
--
-- Keys are mirrored in backend/utils/permissions.js, which is the source the
-- API and UI both read from; the CHECK below keeps the column honest if a row
-- is ever written by hand.
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_permissions_valid;
ALTER TABLE users
    ADD CONSTRAINT users_permissions_valid
    CHECK (
        permissions <@ ARRAY[
            'files.download',
            'files.upload',
            'files.edit',
            'files.delete',
            'files.trash',
            'files.share'
        ]::text[]
    );

-- Owners are implicitly all-powerful over their own account, so a populated
-- permission set on a top-level account would be misleading dead data.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_owner_has_no_permissions;
ALTER TABLE users
    ADD CONSTRAINT users_owner_has_no_permissions
    CHECK (parent_user_id IS NOT NULL OR permissions = '{}'::text[]);

-- A sub-user cannot be its own parent.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_parent_not_self;
ALTER TABLE users
    ADD CONSTRAINT users_parent_not_self
    CHECK (parent_user_id IS NULL OR parent_user_id <> id);

-- "A sub-user cannot create sub-users" needs to look at the *parent's* row, so
-- a CHECK constraint cannot express it (those only see the row being written).
-- A trigger can, and enforcing it here means the rule holds for every writer —
-- application code, migrations, and manual psql alike.
CREATE OR REPLACE FUNCTION users_reject_nested_sub_user() RETURNS TRIGGER AS $$
DECLARE
    parent_parent TEXT;
BEGIN
    IF NEW.parent_user_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT parent_user_id INTO parent_parent FROM users WHERE id = NEW.parent_user_id;

    IF parent_parent IS NOT NULL THEN
        RAISE EXCEPTION 'Sub-users cannot create sub-users (% is already a sub-user of %)',
            NEW.parent_user_id, parent_parent
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_reject_nested_sub_user ON users;
CREATE TRIGGER trg_users_reject_nested_sub_user
    BEFORE INSERT OR UPDATE OF parent_user_id ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_reject_nested_sub_user();

-- The mirror case: an owner that already has sub-users must not be demoted
-- into a sub-user, which would strand its members one level too deep.
CREATE OR REPLACE FUNCTION users_reject_demoting_parent() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parent_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users WHERE parent_user_id = NEW.id) THEN
        RAISE EXCEPTION 'Cannot make % a sub-user because it already owns sub-users', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_reject_demoting_parent ON users;
CREATE TRIGGER trg_users_reject_demoting_parent
    BEFORE UPDATE OF parent_user_id ON users
    FOR EACH ROW
    EXECUTE FUNCTION users_reject_demoting_parent();

-- Listing an owner's sub-users is the hot path for the management screen.
CREATE INDEX IF NOT EXISTS idx_users_parent_user_id
    ON users(parent_user_id)
    WHERE parent_user_id IS NOT NULL;

COMMENT ON COLUMN users.parent_user_id IS
    'Account owner for sub-users; NULL for top-level accounts. Files and storage quota belong to COALESCE(parent_user_id, id).';
COMMENT ON COLUMN users.permissions IS
    'Capabilities granted to a sub-user. Always empty for owners, who are implicitly permitted everything on their own account.';

-- ---------------------------------------------------------------------------
-- Audit log: record which account an action happened under, and what role the
-- actor held at the time. `user_id` stays the acting identity, so a query like
--
--   SELECT created_at, user_id, actor_role, action, resource_id
--     FROM audit_log WHERE account_owner_id = '<owner>' ORDER BY created_at DESC;
--
-- reads as "who did what" across the owner and all of their sub-users.
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS account_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_role TEXT;

-- Existing rows were all written by top-level accounts acting for themselves.
UPDATE audit_log SET account_owner_id = user_id WHERE account_owner_id IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_account_activity
    ON audit_log(account_owner_id, created_at DESC)
    WHERE account_owner_id IS NOT NULL;

COMMENT ON COLUMN audit_log.account_owner_id IS
    'Account the action was performed under. Equals user_id for owners; the parent for sub-users.';
COMMENT ON COLUMN audit_log.actor_role IS
    'Whether user_id acted as the account owner or as a sub-user when the event was recorded.';

-- ---------------------------------------------------------------------------
-- A view that answers "who did what" without hand-writing joins every time.
-- IDs alone are unreadable, so this resolves both the actor and the account to
-- names and emails:
--
--   SELECT * FROM audit_activity
--    WHERE account_email = 'team@example.com'
--    ORDER BY created_at DESC LIMIT 100;
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW audit_activity AS
SELECT
    a.id,
    a.created_at,
    a.action,
    a.status,
    a.actor_role,
    a.user_id            AS actor_id,
    actor.name           AS actor_name,
    actor.email          AS actor_email,
    a.account_owner_id,
    owner.email          AS account_email,
    -- Distinguishes an owner acting for themselves from a member acting on the
    -- shared account, which is the question the audit trail exists to answer.
    (a.user_id IS DISTINCT FROM a.account_owner_id) AS acted_as_sub_user,
    a.resource_type,
    a.resource_id,
    a.metadata,
    a.ip_address,
    a.user_agent,
    a.error_message,
    a.processing_time_ms,
    a.request_id
FROM audit_log a
LEFT JOIN users actor ON actor.id = a.user_id
LEFT JOIN users owner ON owner.id = a.account_owner_id;

COMMENT ON VIEW audit_activity IS
    'Human-readable audit trail: resolves actor and account IDs to names/emails and flags sub-user activity.';
