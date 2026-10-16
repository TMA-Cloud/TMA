-- One key check value per master key (KEK) version: an HMAC of a fixed label,
-- so a process can tell at startup that it holds the right key without the
-- database ever storing anything that reveals it.
CREATE TABLE IF NOT EXISTS kek_checks (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    check_value BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
