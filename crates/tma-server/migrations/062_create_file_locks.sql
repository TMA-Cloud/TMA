-- Edit locks: the desktop app holds one while a file is open for editing, so
-- others open it read-only instead of saving over each other. A lock is a
-- lease the app renews; one it stops renewing (a crash, a lost network) simply
-- expires, so a file is never stuck locked.
CREATE TABLE IF NOT EXISTS file_locks (
    file_id     TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
);
