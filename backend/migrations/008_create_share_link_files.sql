CREATE TABLE IF NOT EXISTS share_link_files (
    share_id TEXT REFERENCES share_links(id) ON DELETE CASCADE,
    file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (share_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_share_link_files_file_id ON share_link_files(file_id);
