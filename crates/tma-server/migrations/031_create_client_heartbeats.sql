CREATE TABLE IF NOT EXISTS client_heartbeats (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id VARCHAR(255),
  app_version VARCHAR(64) NOT NULL,
  platform VARCHAR(64),
  user_agent TEXT,
  ip_address VARCHAR(45),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_heartbeats_user_id ON client_heartbeats(user_id);
CREATE INDEX IF NOT EXISTS idx_client_heartbeats_last_seen ON client_heartbeats(last_seen_at);
