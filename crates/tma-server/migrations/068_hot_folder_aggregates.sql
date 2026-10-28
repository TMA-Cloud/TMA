-- Cheaper folder totals.
--
-- Every upload, save, copy or delete updates the totals of each folder above
-- the file. aggregate_size was a key of idx_files_active_parent_size_page, so
-- none of those updates could be HOT: each wrote a new entry into every index
-- on files. The index never served its sort, which orders by a COALESCE of the
-- same expression; size-sorted listings read the folder through the other
-- listing indexes and sort it, with or without this one.
DROP INDEX IF EXISTS idx_files_active_parent_size_page;

-- Leave room on each page so an updated row can stay on it, which HOT needs.
ALTER TABLE files SET (fillfactor = 90);
