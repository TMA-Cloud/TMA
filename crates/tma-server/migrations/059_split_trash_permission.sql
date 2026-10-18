-- "Manage trash" becomes two grants: restoring from the trash, and deleting
-- permanently (which includes emptying it). Sub-users who could manage the
-- trash keep both.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_permissions_valid;

UPDATE users
   SET permissions = array_remove(permissions, 'files.trash') || ARRAY['files.restore', 'files.purge']::text[]
 WHERE 'files.trash' = ANY(permissions);

ALTER TABLE users
    ADD CONSTRAINT users_permissions_valid
    CHECK (
        permissions <@ ARRAY[
            'files.download',
            'files.upload',
            'files.edit',
            'files.delete',
            'files.restore',
            'files.purge',
            'files.share'
        ]::text[]
    );
