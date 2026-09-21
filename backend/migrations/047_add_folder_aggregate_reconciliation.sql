-- Folder aggregates are the only source of a folder's size, file count and
-- folder count now that the recursive read-path queries are gone. Incremental
-- trigger maintenance can drift -- adjust_file_ancestor_aggregates() clamps at
-- zero, so a delta that would go negative is lost rather than corrected, and
-- any write path that bypasses row triggers leaves the counters behind.
--
-- This recomputes them from the rows themselves, for one account, and reports
-- how many folders were wrong so drift is visible rather than silent.
--
-- The definition deliberately matches migration 044: every descendant counts,
-- trashed or not, because the trigger does not fire on deleted_at and the
-- listing columns have always included trashed children.
CREATE OR REPLACE FUNCTION reconcile_folder_aggregates(target_user TEXT)
RETURNS INTEGER AS $$
DECLARE
  repaired INTEGER := 0;
BEGIN
  WITH RECURSIVE ancestry(descendant_id, ancestor_id, visited) AS (
    -- Walking up from each node costs one row per (node, ancestor) pair, where
    -- walking down from each folder would re-expand every subtree per root.
    SELECT f.id, f.parent_id, ARRAY[f.id, f.parent_id]
      FROM files f
     WHERE f.user_id = target_user AND f.parent_id IS NOT NULL
    UNION ALL
    SELECT ancestry.descendant_id, parent.parent_id, ancestry.visited || parent.parent_id
      FROM ancestry
      JOIN files parent ON parent.id = ancestry.ancestor_id
     WHERE parent.parent_id IS NOT NULL
       AND NOT parent.parent_id = ANY(ancestry.visited)
  ), totals AS (
    SELECT ancestry.ancestor_id AS id,
           COALESCE(SUM(descendant.size) FILTER (WHERE descendant.type = 'file'), 0)::bigint AS bytes,
           COUNT(*) FILTER (WHERE descendant.type = 'file')::integer AS files,
           COUNT(*) FILTER (WHERE descendant.type = 'folder')::integer AS folders
      FROM ancestry
      JOIN files descendant ON descendant.id = ancestry.descendant_id
     GROUP BY ancestry.ancestor_id
  ), corrected AS (
    UPDATE files folder
       SET aggregate_size = COALESCE(totals.bytes, 0),
           aggregate_file_count = COALESCE(totals.files, 0),
           aggregate_folder_count = COALESCE(totals.folders, 0)
      FROM (SELECT id FROM files WHERE user_id = target_user AND type = 'folder') AS owned
      LEFT JOIN totals ON totals.id = owned.id
     WHERE folder.id = owned.id
       AND (folder.aggregate_size, folder.aggregate_file_count, folder.aggregate_folder_count)
           IS DISTINCT FROM (COALESCE(totals.bytes, 0), COALESCE(totals.files, 0), COALESCE(totals.folders, 0))
    RETURNING folder.id
  )
  SELECT COUNT(*)::integer INTO repaired FROM corrected;

  RETURN repaired;
END;
$$ LANGUAGE plpgsql;
