//! The entries of a ZIP download, streamed from one recursive query with their
//! final archive paths. Small trees are read eagerly so the connection returns
//! to the pool at once; larger ones hold a connection, capped process-wide.

use std::sync::{Arc, OnceLock};

use futures::{Stream, StreamExt};
use sqlx::PgPool;
use tokio::sync::Semaphore;

const PREFETCH_ROWS: usize = 20_000;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ArchiveEntry {
    pub id: String,
    #[sqlx(rename = "type")]
    pub item_type: String,
    pub path: Option<String>,
    pub archive_path: String,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub modified: chrono::DateTime<chrono::Utc>,
    pub dek_wrapped: Option<Vec<u8>>,
    pub dek_kek_version: Option<i32>,
}

fn held_slots(limit: usize) -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(limit.max(1)))).clone()
}

const OWNER_TREE: &str = "WITH RECURSIVE tree(id, type, path, mime_type, size, modified, dek_wrapped, dek_kek_version, archive_path, visited) AS (
    SELECT f.id, f.type, f.path, f.mime_type, f.size, f.modified, f.dek_wrapped, f.dek_kek_version, f.name::text, ARRAY[f.id]
      FROM files f WHERE f.id = ANY($1::text[]) AND f.user_id = $2 AND f.deleted_at IS NULL
    UNION ALL
    SELECT f.id, f.type, f.path, f.mime_type, f.size, f.modified, f.dek_wrapped, f.dek_kek_version, tree.archive_path || '/' || f.name, tree.visited || f.id
      FROM files f JOIN tree ON f.parent_id = tree.id
     WHERE f.user_id = $2 AND f.deleted_at IS NULL AND NOT f.id = ANY(tree.visited)
  ) SELECT id, type, path, archive_path, mime_type, size, modified, dek_wrapped, dek_kek_version FROM tree ORDER BY archive_path, id";

const SHARED_TREE: &str = "WITH RECURSIVE tree(id, type, path, mime_type, size, modified, dek_wrapped, dek_kek_version, archive_path, visited) AS (
    SELECT f.id, f.type, f.path, f.mime_type, f.size, f.modified, f.dek_wrapped, f.dek_kek_version, f.name::text, ARRAY[f.id]
      FROM files f JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1
     WHERE f.id = ANY($2::text[]) AND f.deleted_at IS NULL
    UNION ALL
    SELECT f.id, f.type, f.path, f.mime_type, f.size, f.modified, f.dek_wrapped, f.dek_kek_version, tree.archive_path || '/' || f.name, tree.visited || f.id
      FROM files f JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1
      JOIN tree ON f.parent_id = tree.id
     WHERE f.deleted_at IS NULL AND NOT f.id = ANY(tree.visited)
  ) SELECT id, type, path, archive_path, mime_type, size, modified, dek_wrapped, dek_kek_version FROM tree ORDER BY archive_path, id";

fn stream_query(
    pool: PgPool,
    sql: &'static str,
    first: Vec<String>,
    second: Vec<String>,
    shared: bool,
    held_limit: usize,
) -> impl Stream<Item = anyhow::Result<ArchiveEntry>> + Send {
    async_stream::try_stream! {
        let slots = held_slots(held_limit);
        let permit = slots.acquire_owned().await?;
        let mut head = Vec::new();
        let mut exhausted = false;
        {
            let query = if shared {
                sqlx::query_as::<_, ArchiveEntry>(sql).bind(first.first().cloned().unwrap_or_default()).bind(second.clone())
            } else {
                sqlx::query_as::<_, ArchiveEntry>(sql).bind(first.clone()).bind(second.first().cloned().unwrap_or_default())
            };
            let mut rows = query.fetch(&pool);
            while head.len() < PREFETCH_ROWS {
                match rows.next().await {
                    Some(row) => head.push(row?),
                    None => { exhausted = true; break; }
                }
            }
            if exhausted {
                drop(rows);
                drop(permit);
                for entry in head.drain(..) {
                    yield entry;
                }
            } else {
                for entry in head.drain(..) {
                    yield entry;
                }
                while let Some(row) = rows.next().await {
                    yield row?;
                }
            }
        }
    }
}

/// Entries of the given roots on an owner's account.
pub fn owner_entries(
    pool: PgPool,
    roots: Vec<String>,
    owner: String,
    held_limit: usize,
) -> impl Stream<Item = anyhow::Result<ArchiveEntry>> + Send {
    stream_query(pool, OWNER_TREE, roots, vec![owner], false, held_limit)
}

/// Entries of a subtree inside a share, limited to the share's members.
pub fn shared_entries(
    pool: PgPool,
    token: String,
    root: String,
    held_limit: usize,
) -> impl Stream<Item = anyhow::Result<ArchiveEntry>> + Send {
    stream_query(pool, SHARED_TREE, vec![token], vec![root], true, held_limit)
}
