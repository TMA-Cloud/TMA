//! Moving and copying trees. A move re-parents rows (name clashes keep both);
//! a copy plans the tree in one recursive read, copies objects server-side in
//! the bucket, then inserts every row in one transaction.

use std::collections::{HashMap, HashSet};

use sqlx::{PgPool, Postgres, Transaction};

use super::{allocate_name, assert_live_folders, clash_pattern};
use crate::error::DomainError;
use crate::storage::Storage;

/// A free name in the target folder for each incoming item, in order; files and
/// folders are de-duplicated against their own type, as uploads are.
async fn allocate_target_names(
    tx: &mut Transaction<'_, Postgres>,
    owner: &str,
    parent: Option<&str>,
    items: &[(Option<String>, String, String)],
) -> anyhow::Result<Vec<String>> {
    let idx: Vec<i32> = (0..items.len() as i32).collect();
    let desired: Vec<&str> = items.iter().map(|(_, n, _)| n.as_str()).collect();
    let patterns: Vec<String> = items.iter().map(|(_, n, t)| clash_pattern(n, t == "file")).collect();
    let types: Vec<&str> = items.iter().map(|(_, _, t)| t.as_str()).collect();
    let exclude: Vec<&str> = items.iter().filter_map(|(id, _, _)| id.as_deref()).collect();
    let occupied: Vec<(i32, String)> = sqlx::query_as(
        r"WITH requested(idx, desired, pattern, type) AS (SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]))
          SELECT requested.idx, f.name FROM requested JOIN files f
            ON f.user_id = $5 AND f.parent_id IS NOT DISTINCT FROM $6 AND f.type = requested.type AND f.deleted_at IS NULL
           AND NOT f.id = ANY($7::text[])
           AND (LOWER(f.name) = LOWER(requested.desired) OR LOWER(f.name) LIKE LOWER(requested.pattern) ESCAPE '\')",
    )
    .bind(&idx)
    .bind(&desired)
    .bind(&patterns)
    .bind(&types)
    .bind(owner)
    .bind(parent)
    .bind(&exclude)
    .fetch_all(&mut **tx)
    .await?;
    let mut taken_by: HashMap<i32, HashSet<String>> = HashMap::new();
    for (i, name) in occupied {
        taken_by.entry(i).or_default().insert(name.to_lowercase());
    }
    let mut batch: HashMap<&str, HashSet<String>> = HashMap::new();
    let mut out = Vec::with_capacity(items.len());
    for (i, (_, name, kind)) in items.iter().enumerate() {
        let used = batch.entry(kind.as_str()).or_default();
        let mut taken = taken_by.remove(&(i as i32)).unwrap_or_default();
        taken.extend(used.iter().cloned());
        let chosen = allocate_name(name, &taken, kind == "file")?;
        used.insert(chosen.to_lowercase());
        out.push(chosen);
    }
    Ok(out)
}

/// Move items under `parent` (root when `None`). Hierarchy changes of one
/// account are serialised across processes by an advisory lock.
pub async fn move_items(pool: &PgPool, ids: &[String], parent: Option<&str>, owner: &str) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))").bind(owner).execute(&mut *tx).await?;
    let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, parent_id, type, name FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL
          ORDER BY array_position($1::text[], id) FOR UPDATE",
    )
    .bind(ids)
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?;
    let unique: HashSet<&String> = ids.iter().collect();
    if rows.len() != unique.len() {
        return Err(DomainError::NotFound("Some items no longer exist or are in the trash".into()).into());
    }
    if let Some(target) = parent {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT id FROM files WHERE id = $1 AND user_id = $2 AND type = 'folder' AND deleted_at IS NULL FOR UPDATE",
        )
        .bind(target)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
        if found.is_none() {
            return Err(DomainError::NotFound("Target folder not found".into()).into());
        }
        let cycle: Option<i32> = sqlx::query_scalar(
            "WITH RECURSIVE descendants(id, visited) AS (
               SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2
               UNION ALL
               SELECT child.id, descendants.visited || child.id FROM files child JOIN descendants ON child.parent_id = descendants.id
                WHERE child.user_id = $2 AND NOT child.id = ANY(descendants.visited)
             ) SELECT 1 FROM descendants WHERE id = $3 LIMIT 1",
        )
        .bind(ids)
        .bind(owner)
        .bind(target)
        .fetch_optional(&mut *tx)
        .await?;
        if cycle.is_some() {
            return Err(DomainError::BadRequest(
                "A folder cannot be moved into itself or one of its descendants".into(),
            )
            .into());
        }
    }
    // Items already in the target stay put, like a paste back into the same folder.
    let moving: Vec<&(String, Option<String>, String, String)> =
        rows.iter().filter(|r| r.1.as_deref() != parent).collect();
    if !moving.is_empty() {
        let items: Vec<(Option<String>, String, String)> =
            moving.iter().map(|r| (Some(r.0.clone()), r.3.clone(), r.2.clone())).collect();
        let names = allocate_target_names(&mut tx, owner, parent, &items).await?;
        let move_ids: Vec<&str> = moving.iter().map(|r| r.0.as_str()).collect();
        sqlx::query(
            "UPDATE files f SET parent_id = $1, name = incoming.name FROM unnest($2::text[], $3::text[]) AS incoming(id, name)
              WHERE f.id = incoming.id AND f.user_id = $4",
        )
        .bind(parent)
        .bind(&move_ids)
        .bind(&names)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Reserve quota for a long object copy without holding the account row lock during I/O.
async fn reserve(pool: &PgPool, owner: &str, bytes: i64, purpose: &str) -> anyhow::Result<Option<String>> {
    if bytes <= 0 {
        return Ok(None);
    }
    let mut tx = pool.begin().await?;
    super::crud::check_quota(&mut tx, owner, bytes).await?;
    let id = crate::util::generate_id();
    sqlx::query("INSERT INTO storage_reservations(id, user_id, bytes, purpose, expires_at) VALUES($1, $2, $3, $4, NOW() + INTERVAL '24 hours')")
        .bind(&id)
        .bind(owner)
        .bind(bytes)
        .bind(purpose)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(id))
}

async fn release<'e, E: sqlx::PgExecutor<'e>>(db: E, id: Option<&str>) {
    if let Some(id) = id {
        let _ = sqlx::query("DELETE FROM storage_reservations WHERE id = $1").bind(id).execute(db).await;
    }
}

#[derive(sqlx::FromRow)]
struct StageFile {
    source_path: Option<String>,
    new_path: Option<String>,
    size: Option<i64>,
}

/// Copy items under `parent`. With `operation_id` the copy is idempotent: a
/// retried job returns the IDs the first attempt committed.
pub async fn copy_items(
    pool: &PgPool,
    storage: &Storage,
    ids: &[String],
    parent: Option<&str>,
    owner: &str,
    operation_id: Option<uuid::Uuid>,
) -> anyhow::Result<Vec<String>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(op) = operation_id {
        let done: Option<serde_json::Value> = sqlx::query_scalar(
            "SELECT output FROM file_operation_results WHERE job_id = $1 AND user_id = $2 AND task = 'copy'",
        )
        .bind(op)
        .bind(owner)
        .fetch_optional(pool)
        .await?;
        if let Some(out) = done {
            return Ok(serde_json::from_value(out.get("ids").cloned().unwrap_or_default()).unwrap_or_default());
        }
    }
    assert_live_folders(pool, &[parent.map(String::from)], owner).await?;
    let mut conn = pool.acquire().await?;
    let seed = operation_id.map(|o| o.to_string());
    sqlx::query(
        r"CREATE TEMP TABLE copy_stage ON COMMIT PRESERVE ROWS AS
          WITH RECURSIVE tree AS (
            SELECT f.*, roots.ordinality::integer AS root_order, 0 AS depth, ARRAY[f.id]::text[] AS ancestors
              FROM unnest($1::text[]) WITH ORDINALITY AS roots(id, ordinality) JOIN files f ON f.id = roots.id
             WHERE f.user_id = $2 AND f.deleted_at IS NULL
            UNION ALL
            SELECT child.*, tree.root_order, tree.depth + 1, tree.ancestors || child.id
              FROM files child JOIN tree ON child.parent_id = tree.id
             WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(tree.ancestors)
          ), planned AS (
            SELECT tree.*, SUBSTRING(MD5(COALESCE($3::text, RANDOM()::text) || ':' || id || ':' || root_order::text), 1, 16) AS new_id FROM tree
          )
          SELECT id AS source_id, parent_id AS source_parent_id, root_order, depth, new_id, name AS new_name, type, size, mime_type,
                 path AS source_path,
                 CASE WHEN type = 'file' THEN new_id || COALESCE(SUBSTRING(name FROM '^.+?(\.[^.]*)$'), '') ELSE NULL END AS new_path,
                 NULL::text AS new_parent_id, starred, modified, dek_wrapped, dek_kek_version
            FROM planned",
    )
    .bind(ids)
    .bind(owner)
    .bind(seed)
    .execute(&mut *conn)
    .await?;
    let result = copy_staged(pool, storage, &mut conn, parent, owner, operation_id).await;
    let _ = sqlx::query("DROP TABLE IF EXISTS copy_stage").execute(&mut *conn).await;
    result
}

async fn copy_staged(
    pool: &PgPool,
    storage: &Storage,
    conn: &mut sqlx::PgConnection,
    parent: Option<&str>,
    owner: &str,
    operation_id: Option<uuid::Uuid>,
) -> anyhow::Result<Vec<String>> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM copy_stage").fetch_one(&mut *conn).await?;
    if count == 0 {
        return Ok(Vec::new());
    }
    sqlx::query("CREATE INDEX copy_stage_parent_idx ON copy_stage(root_order, source_parent_id)")
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "UPDATE copy_stage child SET new_parent_id = parent.new_id FROM copy_stage parent
          WHERE child.depth > 0 AND parent.root_order = child.root_order AND parent.source_id = child.source_parent_id",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query("UPDATE copy_stage SET new_parent_id = $1 WHERE depth = 0").bind(parent).execute(&mut *conn).await?;
    let roots: Vec<(i32, String, String, String)> =
        sqlx::query_as("SELECT root_order, new_id, new_name, type FROM copy_stage WHERE depth = 0 ORDER BY root_order")
            .fetch_all(&mut *conn)
            .await?;
    let mut tx = sqlx::Connection::begin(&mut *conn).await?;
    let items: Vec<(Option<String>, String, String)> = roots.iter().map(|r| (None, r.2.clone(), r.3.clone())).collect();
    let names = allocate_target_names(&mut tx, owner, parent, &items).await?;
    tx.commit().await?;
    let orders: Vec<i32> = roots.iter().map(|r| r.0).collect();
    sqlx::query(
        "UPDATE copy_stage stage SET new_name = incoming.name FROM unnest($1::int[], $2::text[]) AS incoming(root_order, name)
          WHERE stage.depth = 0 AND stage.root_order = incoming.root_order",
    )
    .bind(&orders)
    .bind(&names)
    .execute(&mut *conn)
    .await?;
    let bytes: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size), 0)::bigint FROM copy_stage WHERE type = 'file'")
        .fetch_one(&mut *conn)
        .await?;
    let reservation = reserve(pool, owner, bytes, "file-copy").await?;

    let files = sqlx::query_as::<_, StageFile>(
        "SELECT source_path, new_path, size FROM copy_stage WHERE type = 'file' ORDER BY new_path",
    )
    .fetch_all(&mut *conn)
    .await?;
    let copied = copy_objects(storage, &files).await;
    if let Err(err) = copied {
        release(pool, reservation.as_deref()).await;
        let keys: Vec<String> = files.iter().filter_map(|f| f.new_path.clone()).collect();
        let _ = storage.delete_many(&keys).await;
        return Err(err);
    }

    let mut tx = sqlx::Connection::begin(&mut *conn).await?;
    let insert = async {
        // The target may have been trashed while the job waited in the queue.
        assert_live_folders(&mut *tx, &[parent.map(String::from)], owner).await?;
        sqlx::query(
            "INSERT INTO files (id, name, type, size, mime_type, path, parent_id, user_id, starred, shared, modified, dek_wrapped, dek_kek_version)
             SELECT new_id, new_name, type, size, mime_type, new_path, new_parent_id, $1, starred, FALSE, modified,
                    CASE WHEN type = 'file' THEN dek_wrapped END, CASE WHEN type = 'file' THEN dek_kek_version END
               FROM copy_stage",
        )
        .bind(owner)
        .execute(&mut *tx)
        .await?;
        release(&mut *tx, reservation.as_deref()).await;
        let new_ids: Vec<String> = roots.iter().map(|r| r.1.clone()).collect();
        if let Some(op) = operation_id {
            sqlx::query(
                "INSERT INTO file_operation_results(job_id, user_id, task, output) VALUES($1, $2, 'copy', $3) ON CONFLICT (job_id) DO NOTHING",
            )
            .bind(op)
            .bind(owner)
            .bind(serde_json::json!({ "ids": new_ids, "count": new_ids.len() }))
            .execute(&mut *tx)
            .await?;
        }
        anyhow::Ok(new_ids)
    }
    .await;
    match insert {
        Ok(ids) => {
            tx.commit().await?;
            Ok(ids)
        }
        Err(err) => {
            let _ = tx.rollback().await;
            release(pool, reservation.as_deref()).await;
            let keys: Vec<String> = files.iter().filter_map(|f| f.new_path.clone()).collect();
            let _ = storage.delete_many(&keys).await;
            Err(err)
        }
    }
}

async fn copy_object(storage: &Storage, f: &StageFile) -> anyhow::Result<()> {
    let source = f.source_path.as_deref().ok_or_else(|| anyhow::anyhow!("Source object path is missing"))?;
    let dest = f.new_path.as_deref().ok_or_else(|| anyhow::anyhow!("Destination path is missing"))?;
    let size = crate::crypto::plaintext_size_to_ciphertext_size(f.size.unwrap_or(0).max(0) as u64);
    storage.copy(source, dest, Some(size)).await
}

async fn copy_objects(storage: &Storage, files: &[StageFile]) -> anyhow::Result<()> {
    use futures::StreamExt;
    // Futures are built up front: a closure returning an async block here makes the job future lose `Send`.
    let tasks: Vec<_> = files.iter().map(|f| copy_object(storage, f)).collect();
    let results: Vec<anyhow::Result<()>> = futures::stream::iter(tasks).buffer_unordered(4).collect().await;
    results.into_iter().collect()
}
