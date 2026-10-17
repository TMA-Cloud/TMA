//! Creating, reading, renaming and replacing items. Quota is checked under a
//! lock on the account row in the same transaction as the insert.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sqlx::{PgPool, Postgres, Transaction};
use tma_core::api::FileItem;

use super::{ListRow, allocate_name, assert_live_folders, clash_pattern};
use crate::error::DomainError;
use crate::util::generate_id;

const RETURNING: &str = "RETURNING id, name, type, size, modified, accessed_at, shared_at, mime_type, starred, shared";

/// A stored file as the download path needs it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoredFile {
    pub id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    pub item_type: String,
    pub size: Option<i64>,
    pub mime_type: Option<String>,
    pub path: Option<String>,
    pub parent_id: Option<String>,
    pub dek_wrapped: Option<Vec<u8>>,
    pub dek_kek_version: Option<i32>,
    pub modified: DateTime<Utc>,
}

impl StoredFile {
    pub fn is_folder(&self) -> bool {
        self.item_type == "folder"
    }
}

const STORED_COLUMNS: &str = "id, name, type, size, mime_type, path, parent_id, dek_wrapped, dek_kek_version, modified";

pub async fn get(pool: &PgPool, id: &str, owner: &str) -> anyhow::Result<Option<StoredFile>> {
    let sql = format!("SELECT {STORED_COLUMNS} FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL");
    Ok(sqlx::query_as::<_, StoredFile>(sqlx::AssertSqlSafe(sql)).bind(id).bind(owner).fetch_optional(pool).await?)
}

pub async fn get_many(pool: &PgPool, ids: &[String], owner: &str) -> anyhow::Result<Vec<StoredFile>> {
    let sql = format!(
        "SELECT {STORED_COLUMNS} FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL
          ORDER BY array_position($1::text[], id)"
    );
    Ok(sqlx::query_as::<_, StoredFile>(sqlx::AssertSqlSafe(sql)).bind(ids).bind(owner).fetch_all(pool).await?)
}

/// A new folder row; the caller has checked the parent.
async fn insert_folder(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    name: &str,
    parent: Option<&str>,
    owner: &str,
) -> anyhow::Result<ListRow> {
    let sql =
        format!("INSERT INTO files(id, name, type, parent_id, user_id) VALUES($1, $2, 'folder', $3, $4) {RETURNING}");
    Ok(sqlx::query_as::<_, ListRow>(sqlx::AssertSqlSafe(sql))
        .bind(generate_id())
        .bind(name)
        .bind(parent)
        .bind(owner)
        .fetch_one(&mut **tx)
        .await?)
}

/// Refused when a new or renamed item would share its name with a live sibling.
pub const NAME_TAKEN: &str = "An item with this name is already here";

/// Serialise name changes under one parent and name, so two requests cannot both
/// find a name free; uploads that merge into a folder take the same lock.
async fn lock_name(
    tx: &mut Transaction<'_, Postgres>,
    owner: &str,
    parent: Option<&str>,
    name: &str,
) -> anyhow::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("folder:{owner}:{}:{}", parent.unwrap_or(""), name.to_lowercase()))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Refuse `name` when a live sibling other than `except` has it, ignoring case as
/// Explorer and Finder do; files and folders share one set of names.
async fn refuse_taken(
    tx: &mut Transaction<'_, Postgres>,
    owner: &str,
    parent: Option<&str>,
    name: &str,
    except: Option<&str>,
) -> anyhow::Result<()> {
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM files WHERE user_id = $1 AND deleted_at IS NULL
            AND parent_id IS NOT DISTINCT FROM $2 AND LOWER(name) = LOWER($3) AND id IS DISTINCT FROM $4)",
    )
    .bind(owner)
    .bind(parent)
    .bind(name)
    .bind(except)
    .fetch_one(&mut **tx)
    .await?;
    if taken {
        return Err(DomainError::Conflict(NAME_TAKEN.into()).into());
    }
    Ok(())
}

pub async fn create_folder(pool: &PgPool, name: &str, parent: Option<&str>, owner: &str) -> anyhow::Result<FileItem> {
    let mut tx = pool.begin().await?;
    lock_name(&mut tx, owner, parent, name).await?;
    assert_live_folders(&mut *tx, &[parent.map(String::from)], owner).await?;
    refuse_taken(&mut tx, owner, parent, name, None).await?;
    let row = insert_folder(&mut tx, name, parent, owner).await?;
    tx.commit().await?;
    Ok(row.into())
}

/// The folder called `name` under `parent` (case-insensitive, as Explorer merges),
/// created when missing. An advisory lock stops parallel uploads creating it twice.
pub async fn find_or_create_folder(
    pool: &PgPool,
    name: &str,
    parent: Option<&str>,
    owner: &str,
) -> anyhow::Result<(FileItem, bool)> {
    let mut tx = pool.begin().await?;
    lock_name(&mut tx, owner, parent, name).await?;
    assert_live_folders(&mut *tx, &[parent.map(String::from)], owner).await?;
    let existing = sqlx::query_as::<_, ListRow>(
        "SELECT id, name, type, size, modified, accessed_at, shared_at, mime_type, starred, shared FROM files
          WHERE user_id = $1 AND deleted_at IS NULL AND type = 'folder' AND parent_id IS NOT DISTINCT FROM $2 AND LOWER(name) = LOWER($3)
          ORDER BY name = $3 DESC, created_at, id LIMIT 1",
    )
    .bind(owner)
    .bind(parent)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await?;
    let (row, created) = match existing {
        Some(row) => (row, false),
        None => (insert_folder(&mut tx, name, parent, owner).await?, true),
    };
    tx.commit().await?;
    Ok((row.into(), created))
}

/// A body already streamed into the bucket, waiting for its row.
#[derive(Debug, Clone)]
pub struct StreamedUpload {
    pub id: String,
    pub storage_name: String,
    pub name: String,
    pub size: i64,
    pub mime_type: String,
    pub dek_wrapped: Vec<u8>,
    pub dek_kek_version: i32,
    pub index: usize,
}

/// One planned row of an upload batch.
#[derive(Debug, Clone)]
pub struct PlannedUpload {
    pub upload: StreamedUpload,
    pub parent_id: Option<String>,
    pub modified: Option<DateTime<Utc>>,
    pub client_id: Option<String>,
}

/// Lock the account row and refuse when `added` bytes would cross its limit.
pub async fn check_quota(tx: &mut Transaction<'_, Postgres>, owner: &str, added: i64) -> anyhow::Result<()> {
    let row: Option<(i64, i64, Option<i64>)> =
        sqlx::query_as("SELECT storage_used, storage_reserved, storage_limit FROM users WHERE id = $1 FOR UPDATE")
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await?;
    let Some((used, reserved, limit)) = row else { anyhow::bail!("Storage account not found") };
    if limit.is_some_and(|limit| used + reserved + added > limit) {
        return Err(DomainError::StorageLimit.into());
    }
    Ok(())
}

/// Insert the rows for streamed uploads in one quota transaction, giving each
/// a free name ("photo (2).jpg") in its folder. Returns rows in input order.
pub async fn insert_uploads(pool: &PgPool, entries: &[PlannedUpload], owner: &str) -> anyhow::Result<Vec<FileItem>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let mut tx = pool.begin().await?;
    check_quota(&mut tx, owner, entries.iter().map(|e| e.upload.size).sum()).await?;
    let parents: Vec<Option<String>> = entries.iter().map(|e| e.parent_id.clone()).collect();
    assert_live_folders(&mut *tx, &parents, owner).await?;

    let idx: Vec<i32> = (0..entries.len() as i32).collect();
    let parent_ids: Vec<Option<String>> = parents.clone();
    let desired: Vec<&str> = entries.iter().map(|e| e.upload.name.as_str()).collect();
    let patterns: Vec<String> = entries.iter().map(|e| clash_pattern(&e.upload.name, true)).collect();
    let occupied: Vec<(i32, String)> = sqlx::query_as(
        r"WITH requested(idx, parent_id, desired, pattern) AS (SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]))
          SELECT requested.idx, f.name FROM requested JOIN files f ON f.user_id = $5
             AND f.parent_id IS NOT DISTINCT FROM requested.parent_id AND f.type = 'file' AND f.deleted_at IS NULL
             AND (LOWER(f.name) = LOWER(requested.desired) OR LOWER(f.name) LIKE LOWER(requested.pattern) ESCAPE '\')",
    )
    .bind(&idx)
    .bind(&parent_ids)
    .bind(&desired)
    .bind(&patterns)
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?;
    let mut taken_by_entry: HashMap<i32, HashSet<String>> = HashMap::new();
    for (i, name) in occupied {
        taken_by_entry.entry(i).or_default().insert(name.to_lowercase());
    }
    let mut batch_names: HashMap<Option<String>, HashSet<String>> = HashMap::new();
    let mut names = Vec::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        let batch = batch_names.entry(entry.parent_id.clone()).or_default();
        let mut taken = taken_by_entry.remove(&(i as i32)).unwrap_or_default();
        taken.extend(batch.iter().cloned());
        let name = allocate_name(&entry.upload.name, &taken, true)?;
        batch.insert(name.to_lowercase());
        names.push(name);
    }

    let mut by_id: HashMap<String, FileItem> = HashMap::new();
    for (chunk_index, chunk) in entries.chunks(250).enumerate() {
        let offset = chunk_index * 250;
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified, dek_wrapped, dek_kek_version) ",
        );
        qb.push_values(chunk.iter().enumerate(), |mut b, (i, e)| {
            b.push_bind(e.upload.id.clone())
                .push_bind(names[offset + i].clone())
                .push_bind("file")
                .push_bind(e.upload.size)
                .push_bind(e.upload.mime_type.clone())
                .push_bind(e.upload.storage_name.clone())
                .push_bind(e.parent_id.clone())
                .push_bind(owner.to_string())
                .push("COALESCE(")
                .push_bind_unseparated(e.modified)
                .push_unseparated("::timestamptz, NOW())")
                .push_bind(e.upload.dek_wrapped.clone())
                .push_bind(e.upload.dek_kek_version);
        });
        qb.push(
            " RETURNING id, name, type, size, modified, accessed_at, shared_at, mime_type, starred, shared, parent_id",
        );
        for row in qb.build_query_as::<ListRow>().fetch_all(&mut *tx).await? {
            let item: FileItem = row.into();
            by_id.insert(item.id.clone(), item);
        }
    }
    tx.commit().await?;
    Ok(entries
        .iter()
        .filter_map(|e| {
            let mut item = by_id.remove(&e.upload.id)?;
            item.client_id = e.client_id.clone();
            Some(item)
        })
        .collect())
}

/// Rename in place; the storage key never changes, so names never leak into bucket keys.
pub async fn rename(
    pool: &PgPool,
    id: &str,
    name: &str,
    owner: &str,
) -> anyhow::Result<Option<(FileItem, String, Option<String>)>> {
    let mut tx = pool.begin().await?;
    let old: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, parent_id FROM files WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((old_name, parent)) = old else { return Ok(None) };
    lock_name(&mut tx, owner, parent.as_deref(), name).await?;
    // The item itself does not count, so a change of case alone goes through.
    refuse_taken(&mut tx, owner, parent.as_deref(), name, Some(id)).await?;
    let sql = format!("UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3 {RETURNING}");
    let row = sqlx::query_as::<_, ListRow>(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row.map(|r| (r.into(), old_name, parent)))
}

/// Point a file at freshly streamed bytes; returns the row and the superseded key.
pub async fn replace_data(
    pool: &PgPool,
    id: &str,
    owner: &str,
    upload: &StreamedUpload,
    modified: Option<DateTime<Utc>>,
) -> anyhow::Result<Option<(FileItem, Option<String>, Option<String>)>> {
    let mut tx = pool.begin().await?;
    let row: Option<(Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT path, parent_id, size FROM files WHERE id = $1 AND user_id = $2 FOR UPDATE")
            .bind(id)
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((old_path, parent, old_size)) = row else { return Ok(None) };
    check_quota(&mut tx, owner, upload.size - old_size.unwrap_or(0)).await?;
    let sql = format!(
        "UPDATE files SET size = $1, mime_type = $2, path = $3, modified = COALESCE($4, NOW()), accessed_at = NOW(),
                dek_wrapped = $5, dek_kek_version = $6 WHERE id = $7 AND user_id = $8 {RETURNING}"
    );
    let updated = sqlx::query_as::<_, ListRow>(sqlx::AssertSqlSafe(sql))
        .bind(upload.size)
        .bind(&upload.mime_type)
        .bind(&upload.storage_name)
        .bind(modified)
        .bind(&upload.dek_wrapped)
        .bind(upload.dek_kek_version)
        .bind(id)
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    let superseded = old_path.filter(|p| p != &upload.storage_name);
    Ok(Some((updated.into(), superseded, parent)))
}

pub async fn set_starred(pool: &PgPool, ids: &[String], starred: bool, owner: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3")
        .bind(starred)
        .bind(ids)
        .bind(owner)
        .execute(pool)
        .await?;
    Ok(())
}
