//! The trash: soft delete of whole trees, restore (with clash renames),
//! permanent deletion in bounded batches, and expiry after 15 days.

use sqlx::PgPool;

use crate::storage::Storage;

/// Move items and their subtrees to the trash; returns every trashed id.
pub async fn trash(pool: &PgPool, ids: &[String], owner: &str) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE sub(id, visited) AS (
           SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL
           UNION ALL
           SELECT child.id, sub.visited || child.id FROM files child JOIN sub ON child.parent_id = sub.id
            WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(sub.visited)
         )
         UPDATE files SET deleted_at = NOW() WHERE user_id = $2 AND id IN (SELECT id FROM sub) RETURNING id",
    )
    .bind(ids)
    .bind(owner)
    .fetch_all(pool)
    .await?)
}

/// Share tokens of every share that includes any of these items.
pub async fn shares_containing(pool: &PgPool, ids: &[String]) -> anyhow::Result<Vec<String>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_scalar("SELECT DISTINCT share_id FROM share_link_files WHERE file_id = ANY($1::text[])")
        .bind(ids)
        .fetch_all(pool)
        .await?)
}

/// Items in the selected trees (live or trashed), or the whole trash.
pub async fn count_tree(
    pool: &PgPool,
    ids: &[String],
    owner: &str,
    deleted: bool,
    all_trash: bool,
) -> anyhow::Result<i64> {
    if all_trash {
        return Ok(sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL")
            .bind(owner)
            .fetch_one(pool)
            .await?);
    }
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE sub(id, visited) AS (
           SELECT f.id, ARRAY[f.id] FROM files f WHERE f.user_id = $2 AND f.id = ANY($1::text[])
              AND (($3 AND f.deleted_at IS NOT NULL) OR (NOT $3 AND f.deleted_at IS NULL))
           UNION ALL
           SELECT child.id, sub.visited || child.id FROM files child JOIN sub ON child.parent_id = sub.id
            WHERE child.user_id = $2 AND (($3 AND child.deleted_at IS NOT NULL) OR (NOT $3 AND child.deleted_at IS NULL))
              AND NOT child.id = ANY(sub.visited)
         ) SELECT COUNT(DISTINCT id) FROM sub",
    )
    .bind(ids)
    .bind(owner)
    .bind(deleted)
    .fetch_one(pool)
    .await?)
}

/// Restore trees to where they were (or the root when that folder is gone),
/// renaming any item whose name is now taken.
pub async fn restore(pool: &PgPool, ids: &[String], owner: &str) -> anyhow::Result<i64> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "CREATE TEMP TABLE restore_stage ON COMMIT DROP AS
         WITH RECURSIVE sub(id, name, parent_id, depth, visited) AS (
           SELECT id, name, parent_id, 0, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NOT NULL
           UNION ALL
           SELECT child.id, child.name, child.parent_id, sub.depth + 1, sub.visited || child.id
             FROM files child JOIN sub ON child.parent_id = sub.id
            WHERE child.user_id = $2 AND child.deleted_at IS NOT NULL AND NOT child.id = ANY(sub.visited)
         )
         SELECT DISTINCT ON (id) id, name, parent_id, depth, NULL::text AS new_parent_id, NULL::text AS new_name
           FROM sub ORDER BY id, depth",
    )
    .bind(ids)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM restore_stage").fetch_one(&mut *tx).await?;
    if staged == 0 {
        tx.commit().await?;
        return Ok(0);
    }
    sqlx::query(
        "UPDATE restore_stage stage SET new_parent_id = CASE
           WHEN stage.parent_id IS NULL THEN NULL
           WHEN EXISTS (SELECT 1 FROM restore_stage parent WHERE parent.id = stage.parent_id) THEN stage.parent_id
           WHEN EXISTS (SELECT 1 FROM files parent WHERE parent.id = stage.parent_id AND parent.user_id = $1 AND parent.deleted_at IS NULL)
             THEN stage.parent_id
           ELSE NULL END",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE restore_stage stage SET new_name = CASE WHEN
           EXISTS (SELECT 1 FROM files active WHERE active.user_id = $1 AND active.deleted_at IS NULL
                     AND active.parent_id IS NOT DISTINCT FROM stage.new_parent_id AND lower(active.name) = lower(stage.name))
           OR EXISTS (SELECT 1 FROM restore_stage earlier WHERE earlier.new_parent_id IS NOT DISTINCT FROM stage.new_parent_id
                        AND lower(earlier.name) = lower(stage.name) AND earlier.id < stage.id)
         THEN left(stage.name, 225) || ' (restored-' || stage.id || ')' ELSE stage.name END",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE files AS f SET deleted_at = NULL, parent_id = stage.new_parent_id, name = stage.new_name
           FROM restore_stage stage WHERE f.id = stage.id AND f.user_id = $1",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(staged)
}

/// Permanently delete trashed trees (or the whole trash), deepest rows first,
/// deleting each batch's objects before its rows so nothing is orphaned.
pub async fn delete_forever(
    pool: &PgPool,
    storage: &Storage,
    ids: &[String],
    owner: &str,
    all_trash: bool,
) -> anyhow::Result<i64> {
    let mut conn = pool.acquire().await?;
    sqlx::query("DROP TABLE IF EXISTS delete_stage").execute(&mut *conn).await?;
    sqlx::query(
        "CREATE TEMP TABLE delete_stage ON COMMIT PRESERVE ROWS AS
         WITH RECURSIVE sub(id, path, type, depth, visited) AS (
           SELECT f.id, f.path, f.type, 0, ARRAY[f.id] FROM files f
            WHERE f.user_id = $2 AND f.deleted_at IS NOT NULL
              AND (($3 AND NOT EXISTS (SELECT 1 FROM files parent WHERE parent.id = f.parent_id AND parent.user_id = $2 AND parent.deleted_at IS NOT NULL))
                   OR (NOT $3 AND f.id = ANY($1::text[])))
           UNION ALL
           SELECT child.id, child.path, child.type, sub.depth + 1, sub.visited || child.id
             FROM files child JOIN sub ON child.parent_id = sub.id
            WHERE child.user_id = $2 AND child.deleted_at IS NOT NULL AND NOT child.id = ANY(sub.visited)
         )
         SELECT DISTINCT ON (id) id, path, type, depth FROM sub ORDER BY id, depth DESC",
    )
    .bind(ids)
    .bind(owner)
    .bind(all_trash)
    .execute(&mut *conn)
    .await?;
    let result = async {
        sqlx::query("CREATE INDEX delete_stage_depth_idx ON delete_stage(depth DESC, id)").execute(&mut *conn).await?;
        let mut total = 0i64;
        loop {
            let batch: Vec<(String, Option<String>, String)> =
                sqlx::query_as("SELECT id, path, type FROM delete_stage ORDER BY depth DESC, id LIMIT 500")
                    .fetch_all(&mut *conn)
                    .await?;
            if batch.is_empty() {
                break;
            }
            let keys: Vec<String> = batch.iter().filter(|r| r.2 == "file").filter_map(|r| r.1.clone()).collect();
            if !keys.is_empty() {
                let errors = storage.delete_many(&keys).await?;
                if !errors.is_empty() {
                    anyhow::bail!("{} object deletion(s) failed", errors.len());
                }
            }
            let batch_ids: Vec<&str> = batch.iter().map(|r| r.0.as_str()).collect();
            sqlx::query("DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2")
                .bind(&batch_ids)
                .bind(owner)
                .execute(&mut *conn)
                .await?;
            sqlx::query("DELETE FROM delete_stage WHERE id = ANY($1::text[])")
                .bind(&batch_ids)
                .execute(&mut *conn)
                .await?;
            total += batch_ids.len() as i64;
        }
        anyhow::Ok(total)
    }
    .await;
    let _ = sqlx::query("DROP TABLE IF EXISTS delete_stage").execute(&mut *conn).await;
    result
}

/// One slice of expired-trash cleanup (15 days); `has_more` asks for another slice.
pub async fn cleanup_expired(pool: &PgPool, storage: &Storage) -> anyhow::Result<(i64, i64, bool)> {
    let started = std::time::Instant::now();
    let max_runtime = std::time::Duration::from_secs(45 * 60);
    let (mut files, mut folders, mut batches) = (0i64, 0i64, 0);
    while batches < 100 && started.elapsed() < max_runtime {
        let expired: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT id, path FROM files WHERE type = 'file' AND deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'
              ORDER BY deleted_at, id LIMIT 500",
        )
        .fetch_all(pool)
        .await?;
        if expired.is_empty() {
            break;
        }
        let keys: Vec<String> = expired.iter().filter_map(|r| r.1.clone()).collect();
        let errors = storage.delete_many(&keys).await?;
        if !errors.is_empty() {
            // Object deletion is idempotent: keep the rows so the next run retries the whole batch.
            anyhow::bail!("{} object deletion(s) failed", errors.len());
        }
        let ids: Vec<&str> = expired.iter().map(|r| r.0.as_str()).collect();
        sqlx::query("DELETE FROM files WHERE id = ANY($1::text[]) AND type = 'file' AND deleted_at < NOW() - INTERVAL '15 days'")
            .bind(&ids)
            .execute(pool)
            .await?;
        files += ids.len() as i64;
        batches += 1;
        if ids.len() < 500 {
            break;
        }
    }
    // Folders go only once empty, so a cascade can never take a row whose object was not deleted.
    while batches < 100 && started.elapsed() < max_runtime {
        let deleted = sqlx::query(
            "WITH doomed AS (
               SELECT f.id FROM files f WHERE f.type = 'folder' AND f.deleted_at IS NOT NULL AND f.deleted_at < NOW() - INTERVAL '15 days'
                  AND NOT EXISTS (SELECT 1 FROM files child WHERE child.parent_id = f.id)
                ORDER BY f.deleted_at, f.id LIMIT 500
             ) DELETE FROM files f USING doomed d WHERE f.id = d.id",
        )
        .execute(pool)
        .await?
        .rows_affected() as i64;
        folders += deleted;
        batches += 1;
        if deleted < 500 {
            break;
        }
    }
    let has_more = batches >= 100 || started.elapsed() >= max_runtime;
    tracing::info!(files, folders, batches, has_more, "[Trash] Cleanup slice completed");
    Ok((files, folders, has_more))
}
