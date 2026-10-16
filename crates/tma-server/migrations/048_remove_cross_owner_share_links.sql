-- Before ownership was enforced at creation, sharing another account's file id
-- wrote a share_links row owned by the caller that pointed at that file, and its
-- public page resolved. Legitimate links always share the owner's own files, so
-- any row whose owner differs from the file's owner is one of those. Their
-- share_link_files rows go with them via ON DELETE CASCADE.
DELETE FROM share_links s
 USING files f
 WHERE f.id = s.file_id
   AND f.user_id <> s.user_id;
