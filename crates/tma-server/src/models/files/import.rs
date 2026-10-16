//! Bulk import bookkeeping: every folder and file an import run creates is
//! recorded (migration 045) so a failed run can be rolled back completely.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::storage::Storage;
use crate::util::generate_id;

/// Create a folder for an import run and record it.
pub async fn create_folder(
    pool: &PgPool,
    run: Uuid,
    owner: &str,
    name: &str,
    parent: Option<&str>,
    modified: Option<DateTime<Utc>>,
    depth: i32,
) -> anyhow::Result<String> {
    let id = generate_id();
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO files(id, name, type, parent_id, user_id, modified) VALUES($1, $2, 'folder', $3, $4, COALESCE($5, NOW()))")
        .bind(&id)
        .bind(name)
        .bind(parent)
        .bind(owner)
        .bind(modified)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO bulk_import_items(run_id, user_id, file_id, item_type, depth) VALUES($1, $2, $3, 'folder', $4)",
    )
    .bind(run)
    .bind(owner)
    .bind(&id)
    .bind(depth)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(id)
}

/// Record the files an import batch inserted: `(file id, storage key, depth)`.
pub async fn record_files(
    pool: &PgPool,
    run: Uuid,
    owner: &str,
    files: &[(String, String, i32)],
) -> anyhow::Result<()> {
    let ids: Vec<&str> = files.iter().map(|f| f.0.as_str()).collect();
    let keys: Vec<&str> = files.iter().map(|f| f.1.as_str()).collect();
    let depths: Vec<i32> = files.iter().map(|f| f.2).collect();
    sqlx::query(
        "INSERT INTO bulk_import_items(run_id, user_id, file_id, storage_name, item_type, depth)
         SELECT $1, $2, f.id, f.key, 'file', f.depth FROM unnest($3::text[], $4::text[], $5::int[]) AS f(id, key, depth)",
    )
    .bind(run)
    .bind(owner)
    .bind(&ids)
    .bind(&keys)
    .bind(&depths)
    .execute(pool)
    .await?;
    Ok(())
}

/// Undo a run: delete its objects, then its rows, deepest first. Returns `(files, folders)`.
pub async fn rollback(pool: &PgPool, storage: &Storage, run: Uuid, owner: &str) -> anyhow::Result<(usize, usize)> {
    let (mut files, mut folders) = (0, 0);
    loop {
        let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
            "SELECT file_id, storage_name, item_type FROM bulk_import_items WHERE run_id = $1 AND user_id = $2
              ORDER BY CASE WHEN item_type = 'file' THEN 0 ELSE 1 END, depth DESC, file_id LIMIT 500",
        )
        .bind(run)
        .bind(owner)
        .fetch_all(pool)
        .await?;
        if rows.is_empty() {
            break;
        }
        let keys: Vec<String> = rows.iter().filter_map(|r| r.1.clone()).collect();
        if !keys.is_empty() {
            let failed = storage.delete_many(&keys).await?;
            if !failed.is_empty() {
                anyhow::bail!("{} object(s) could not be deleted during rollback", failed.len());
            }
        }
        let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
        sqlx::query("DELETE FROM files WHERE user_id = $1 AND id = ANY($2::text[])")
            .bind(owner)
            .bind(&ids)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM bulk_import_items WHERE run_id = $1 AND file_id = ANY($2::text[])")
            .bind(run)
            .bind(&ids)
            .execute(pool)
            .await?;
        files += rows.iter().filter(|r| r.2 == "file").count();
        folders += rows.iter().filter(|r| r.2 == "folder").count();
    }
    Ok((files, folders))
}

/// A run that finished needs no rollback record.
pub async fn finish(pool: &PgPool, run: Uuid) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM bulk_import_items WHERE run_id = $1").bind(run).execute(pool).await?;
    Ok(())
}

pub async fn user_id(pool: &PgPool, id: Option<&str>, email: Option<&str>) -> anyhow::Result<String> {
    let found: Option<String> = match (id, email) {
        (Some(id), _) => sqlx::query_scalar("SELECT id FROM users WHERE id = $1").bind(id).fetch_optional(pool).await?,
        (None, Some(email)) => {
            sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
                .bind(crate::util::normalize_email(email).unwrap_or_else(|| email.to_lowercase()))
                .fetch_optional(pool)
                .await?
        }
        (None, None) => anyhow::bail!("Provide --user-id or --user-email"),
    };
    found.ok_or_else(|| anyhow::anyhow!("User not found"))
}
