-- A counter raised by every content replace, so a save made from an older copy
-- can be refused instead of silently overwriting someone else's newer save.
-- `modified` cannot serve: uploads keep the client's own file time.
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_version BIGINT NOT NULL DEFAULT 1;
