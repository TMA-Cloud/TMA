-- Durable, bounded rollback state for the administrative bulk-import scripts.
-- No foreign key is intentional: the manifest must survive file-row deletion
-- until the corresponding storage object has also been removed.
CREATE TABLE IF NOT EXISTS bulk_import_items (
  run_id uuid NOT NULL,
  user_id text NOT NULL,
  file_id text NOT NULL,
  storage_name text,
  item_type text NOT NULL CHECK (item_type IN ('file', 'folder')),
  depth integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_bulk_import_items_created
  ON bulk_import_items (created_at, run_id);
