//! Orphans: objects no row points at, and rows whose object is missing. They
//! are reported, never deleted on a scan; deletion is an itemised admin request,
//! and every entry is checked again at that moment. A grace window keeps
//! in-flight uploads (object written, row not yet) out of the results.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tma_core::api::{
    DatabaseOrphan, OrphanCategory, OrphanDeleteOutcome, OrphanDeleteReport, OrphanItemResult, OrphanReport,
    OrphanTotals, StorageOrphan,
};

use crate::storage::Storage;

pub const DEFAULT_GRACE_MINUTES: i64 = 24 * 60;
const MIN_GRACE: i64 = 60;
const MAX_GRACE: i64 = 525_600;
const MAX_REPORTED: i64 = 2000;
const MAX_DELETE_BATCH: usize = 500;

pub fn normalize_grace(minutes: Option<i64>) -> i64 {
    minutes.unwrap_or(DEFAULT_GRACE_MINUTES).clamp(MIN_GRACE, MAX_GRACE)
}

/// Legacy rows held absolute filesystem paths; those are not storage keys.
fn is_storage_key(path: &str) -> bool {
    !path.is_empty() && !path.starts_with('/') && !(path.len() > 2 && path.as_bytes()[1] == b':')
}

const DB_KEY_FILTER: &str =
    r"f.type = 'file' AND f.path IS NOT NULL AND f.path NOT LIKE '/%' AND f.path !~ '^[A-Za-z]:[\\/]'";

#[derive(sqlx::FromRow)]
struct DbOrphanRow {
    id: String,
    name: String,
    path: String,
    size: Option<i64>,
    mime_type: Option<String>,
    modified: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    user_email: Option<String>,
    user_name: Option<String>,
}

/// Inventory the bucket into a temporary table (bounded memory) and compare.
pub async fn scan(pool: &PgPool, storage: &Storage, grace_minutes: Option<i64>) -> anyhow::Result<OrphanReport> {
    let grace = normalize_grace(grace_minutes);
    let cutoff = Utc::now() - chrono::Duration::minutes(grace);
    let mut conn = pool.acquire().await?;
    sqlx::query("DROP TABLE IF EXISTS orphan_storage_inventory").execute(&mut *conn).await?;
    sqlx::query("CREATE TEMP TABLE orphan_storage_inventory (key TEXT PRIMARY KEY, size BIGINT NOT NULL, last_modified TIMESTAMPTZ)")
        .execute(&mut *conn)
        .await?;
    let result = async {
        let mut total_objects = 0i64;
        let mut token = None;
        loop {
            let (page, next) = storage.list_page(token, 1000).await?;
            total_objects += page.len() as i64;
            if !page.is_empty() {
                let keys: Vec<&str> = page.iter().map(|o| o.key.as_str()).collect();
                let sizes: Vec<i64> = page.iter().map(|o| o.size).collect();
                let times: Vec<Option<DateTime<Utc>>> = page.iter().map(|o| o.last_modified).collect();
                sqlx::query(
                    "INSERT INTO orphan_storage_inventory(key, size, last_modified) SELECT * FROM unnest($1::text[], $2::bigint[], $3::timestamptz[])
                     ON CONFLICT (key) DO UPDATE SET size = EXCLUDED.size, last_modified = EXCLUDED.last_modified",
                )
                .bind(&keys)
                .bind(&sizes)
                .bind(&times)
                .execute(&mut *conn)
                .await?;
            }
            match next {
                Some(t) => token = Some(t),
                None => break,
            }
        }
        let storage_filter = "i.last_modified IS NOT NULL AND i.last_modified <= $1 AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = i.key)";
        let (s_count, s_bytes): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*), COALESCE(SUM(i.size), 0)::bigint FROM orphan_storage_inventory i WHERE {storage_filter}"
        )))
        .bind(cutoff)
        .fetch_one(&mut *conn)
        .await?;
        let s_items: Vec<(String, i64, Option<DateTime<Utc>>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT i.key, i.size, i.last_modified FROM orphan_storage_inventory i WHERE {storage_filter} ORDER BY i.key LIMIT $2"
        )))
        .bind(cutoff)
        .bind(MAX_REPORTED)
        .fetch_all(&mut *conn)
        .await?;
        let db_filter = format!(
            "{DB_KEY_FILTER} AND f.created_at <= $1 AND NOT EXISTS (SELECT 1 FROM orphan_storage_inventory i WHERE i.key = f.path)"
        );
        let (d_count, d_bytes): (i64, i64) =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT COUNT(*), COALESCE(SUM(f.size), 0)::bigint FROM files f WHERE {db_filter}")))
                .bind(cutoff)
                .fetch_one(&mut *conn)
                .await?;
        let d_items = sqlx::query_as::<_, DbOrphanRow>(sqlx::AssertSqlSafe(format!(
            "SELECT f.id, f.name, f.path, f.size, f.mime_type, f.modified, f.created_at, f.deleted_at, u.email AS user_email, u.name AS user_name
               FROM files f LEFT JOIN users u ON u.id = f.user_id WHERE {db_filter} ORDER BY f.id LIMIT $2"
        )))
        .bind(cutoff)
        .bind(MAX_REPORTED)
        .fetch_all(&mut *conn)
        .await?;
        let (database_rows, skipped): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT (SELECT COUNT(*) FROM files f WHERE {DB_KEY_FILTER}),
                    (SELECT COUNT(*) FROM orphan_storage_inventory i WHERE (i.last_modified IS NULL OR i.last_modified > $1)
                       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = i.key))
                  + (SELECT COUNT(*) FROM files f WHERE {DB_KEY_FILTER} AND f.created_at > $1
                       AND NOT EXISTS (SELECT 1 FROM orphan_storage_inventory i WHERE i.key = f.path))"
        )))
        .bind(cutoff)
        .fetch_one(&mut *conn)
        .await?;
        let storage_orphans: Vec<StorageOrphan> =
            s_items.into_iter().map(|(key, size, last_modified)| StorageOrphan { key, size, last_modified }).collect();
        let database_orphans: Vec<DatabaseOrphan> = d_items
            .into_iter()
            .map(|r| DatabaseOrphan {
                id: r.id,
                name: r.name,
                path: r.path,
                size: r.size.unwrap_or(0),
                mime_type: r.mime_type,
                modified: r.modified,
                created_at: r.created_at,
                trashed: r.deleted_at.is_some(),
                owner_email: r.user_email,
                owner_name: r.user_name,
            })
            .collect();
        tracing::info!(grace, total_objects, database_rows, s_count, d_count, skipped, "[Orphans] Scan completed");
        anyhow::Ok(OrphanReport {
            scanned_at: Utc::now(),
            grace_minutes: grace,
            driver: "s3".into(),
            totals: OrphanTotals { stored_objects: total_objects, database_rows, skipped_too_recent: skipped },
            storage_orphans: OrphanCategory { truncated: s_count > storage_orphans.len() as i64, items: storage_orphans, count: s_count, total_bytes: s_bytes },
            database_orphans: OrphanCategory { truncated: d_count > database_orphans.len() as i64, items: database_orphans, count: d_count, total_bytes: d_bytes },
        })
    }
    .await;
    let _ = sqlx::query("DROP TABLE IF EXISTS orphan_storage_inventory").execute(&mut *conn).await;
    result
}

fn skipped(key: Option<String>, id: Option<String>, reason: &str) -> OrphanItemResult {
    OrphanItemResult { key, id, deleted: false, reason: Some(reason.into()) }
}

/// Delete the orphans the admin picked, re-verifying each first.
pub async fn delete(
    pool: &PgPool,
    storage: &Storage,
    keys: &[String],
    ids: &[String],
    grace_minutes: Option<i64>,
) -> anyhow::Result<OrphanDeleteReport> {
    let grace = normalize_grace(grace_minutes);
    let cutoff = Utc::now() - chrono::Duration::minutes(grace);
    let keys: Vec<String> = keys.iter().cloned().collect::<HashSet<_>>().into_iter().take(MAX_DELETE_BATCH).collect();
    let ids: Vec<String> = ids.iter().cloned().collect::<HashSet<_>>().into_iter().take(MAX_DELETE_BATCH).collect();

    let mut storage_results: HashMap<String, OrphanItemResult> = HashMap::new();
    let referenced: HashSet<String> = sqlx::query_scalar("SELECT path FROM files WHERE path = ANY($1::text[])")
        .bind(&keys)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
    let mut deletable = Vec::new();
    for key in &keys {
        if !is_storage_key(key) {
            storage_results.insert(key.clone(), skipped(Some(key.clone()), None, "Not a valid storage key"));
        } else if referenced.contains(key) {
            storage_results.insert(key.clone(), skipped(Some(key.clone()), None, "A file now references this object"));
        } else {
            match storage.stat(key).await {
                Ok(None) => drop(
                    storage_results.insert(key.clone(), skipped(Some(key.clone()), None, "Object no longer exists")),
                ),
                Ok(Some(stat)) if stat.last_modified.is_none_or(|t| t > cutoff) => {
                    storage_results
                        .insert(key.clone(), skipped(Some(key.clone()), None, "Object was written too recently"));
                }
                Ok(Some(_)) => deletable.push(key.clone()),
                Err(err) => {
                    drop(storage_results.insert(key.clone(), skipped(Some(key.clone()), None, &err.to_string())))
                }
            }
        }
    }
    if !deletable.is_empty() {
        let now_referenced: HashSet<String> = sqlx::query_scalar("SELECT path FROM files WHERE path = ANY($1::text[])")
            .bind(&deletable)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
        let safe: Vec<String> = deletable
            .into_iter()
            .filter(|k| {
                let ok = !now_referenced.contains(k);
                if !ok {
                    storage_results
                        .insert(k.clone(), skipped(Some(k.clone()), None, "A file now references this object"));
                }
                ok
            })
            .collect();
        let errors: HashMap<String, String> = storage.delete_many(&safe).await?.into_iter().collect();
        for key in safe {
            let result = match errors.get(&key) {
                Some(reason) => skipped(Some(key.clone()), None, reason),
                None => OrphanItemResult { key: Some(key.clone()), id: None, deleted: true, reason: None },
            };
            storage_results.insert(key, result);
        }
    }

    let rows: Vec<(String, Option<String>, DateTime<Utc>)> =
        sqlx::query_as("SELECT id, path, created_at FROM files WHERE id = ANY($1::text[]) AND type = 'file'")
            .bind(&ids)
            .fetch_all(pool)
            .await?;
    let rows: HashMap<String, (Option<String>, DateTime<Utc>)> =
        rows.into_iter().map(|(id, p, c)| (id, (p, c))).collect();
    let mut db_results: HashMap<String, OrphanItemResult> = HashMap::new();
    let mut missing = Vec::new();
    for id in &ids {
        match rows.get(id) {
            None => drop(db_results.insert(id.clone(), skipped(None, Some(id.clone()), "Row no longer exists"))),
            Some((path, _)) if !path.as_deref().is_some_and(is_storage_key) => {
                db_results.insert(id.clone(), skipped(None, Some(id.clone()), "Row does not map to a storage key"));
            }
            Some((_, created)) if *created > cutoff => {
                db_results.insert(id.clone(), skipped(None, Some(id.clone()), "Row was created too recently"));
            }
            Some((Some(path), _)) => match storage.exists(path).await {
                Ok(true) => {
                    drop(db_results.insert(id.clone(), skipped(None, Some(id.clone()), "Stored object exists again")))
                }
                Ok(false) => missing.push(id.clone()),
                Err(err) => drop(db_results.insert(id.clone(), skipped(None, Some(id.clone()), &err.to_string()))),
            },
            Some(_) => {}
        }
    }
    if !missing.is_empty() {
        let deleted: HashSet<String> = sqlx::query_scalar(
            "DELETE FROM files WHERE id = ANY($1::text[]) AND type = 'file' AND created_at <= $2 RETURNING id",
        )
        .bind(&missing)
        .bind(cutoff)
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect();
        for id in missing {
            let result = if deleted.contains(&id) {
                OrphanItemResult { key: None, id: Some(id.clone()), deleted: true, reason: None }
            } else {
                skipped(None, Some(id.clone()), "Row changed during verification")
            };
            db_results.insert(id, result);
        }
    }
    let outcome = |results: Vec<OrphanItemResult>| {
        let deleted = results.iter().filter(|r| r.deleted).count() as i64;
        OrphanDeleteOutcome { skipped: results.len() as i64 - deleted, deleted, results }
    };
    Ok(OrphanDeleteReport {
        grace_minutes: grace,
        storage: outcome(keys.iter().filter_map(|k| storage_results.remove(k)).collect()),
        database: outcome(ids.iter().filter_map(|i| db_results.remove(i)).collect()),
    })
}
