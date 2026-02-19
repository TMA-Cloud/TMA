ALTER TABLE share_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON share_links(expires_at) WHERE expires_at IS NOT NULL;
