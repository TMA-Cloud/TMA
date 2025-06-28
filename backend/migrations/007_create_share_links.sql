CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY,
    file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_links_file_id ON share_links(file_id);
