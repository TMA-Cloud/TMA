-- Names sort as people read them: ignoring case, and with numbers by value
-- ("Photo 2" before "Photo 10"). A server built without ICU falls back to
-- byte order of the lowercased name, which still ignores case.
DO $$
BEGIN
    CREATE COLLATION IF NOT EXISTS tma_natural (provider = icu, locale = 'und-u-kn-true');
EXCEPTION WHEN OTHERS THEN
    CREATE COLLATION IF NOT EXISTS tma_natural FROM "C";
END
$$;

DROP INDEX IF EXISTS idx_files_active_parent_name_page;

CREATE INDEX IF NOT EXISTS idx_files_active_parent_name_page
ON files (user_id, parent_id, type DESC, (LOWER(name) COLLATE tma_natural), id)
WHERE deleted_at IS NULL;
