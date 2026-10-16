//! Read paths: folder listings, the starred/shared/trash/recent views, search,
//! dashboard counts and Get Info.

use chrono::{DateTime, Utc};
use sqlx::{PgPool, QueryBuilder};
use tma_core::api::{FileInfo, FileItem, FileStats, FolderInfo, ItemType};

use super::{EXPIRY_COLUMN, Keyset, LIST_COLUMNS, ListRow, Page, expiry_join};
use crate::error::DomainError;

/// Which view a listing serves.
pub enum View<'a> {
    Folder(Option<&'a str>),
    Starred,
    Shared,
}

pub async fn list(pool: &PgPool, owner: &str, view: View<'_>, keyset: &Keyset) -> anyhow::Result<Page> {
    let mut qb = QueryBuilder::new(format!("SELECT {LIST_COLUMNS}, "));
    match view {
        View::Shared => {
            qb.push("CASE WHEN share_info.has_perpetual THEN NULL ELSE share_info.expires_at END AS expires_at FROM files f ");
            qb.push("LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = ")
                .push_bind(owner.to_string());
            qb.push(
                " LEFT JOIN LATERAL (SELECT BOOL_OR(sl.expires_at IS NULL) AS has_perpetual, MAX(sl.expires_at) AS expires_at
                   FROM share_link_files slf JOIN share_links sl ON sl.id = slf.share_id
                  WHERE slf.file_id = f.id AND sl.user_id = f.user_id) share_info ON TRUE",
            );
            qb.push(" WHERE f.user_id = ").push_bind(owner.to_string());
            // Top-level shared items only: a shared folder stands for its contents.
            qb.push(" AND f.shared = TRUE AND f.deleted_at IS NULL AND (f.parent_id IS NULL OR parent.shared = FALSE OR parent.shared IS NULL)");
        }
        View::Folder(parent) => {
            qb.push(format!("{EXPIRY_COLUMN} FROM files f {}", expiry_join("f.user_id")));
            qb.push(" WHERE f.user_id = ").push_bind(owner.to_string()).push(" AND f.deleted_at IS NULL");
            match parent {
                Some(p) => {
                    qb.push(" AND f.parent_id = ").push_bind(p.to_string());
                }
                None => {
                    qb.push(" AND f.parent_id IS NULL");
                }
            }
        }
        View::Starred => {
            qb.push(format!("{EXPIRY_COLUMN} FROM files f {}", expiry_join("f.user_id")));
            qb.push(" WHERE f.user_id = ")
                .push_bind(owner.to_string())
                .push(" AND f.starred = TRUE AND f.deleted_at IS NULL");
        }
    }
    keyset.push_where(&mut qb);
    keyset.push_order(&mut qb);
    let rows = qb.build_query_as::<ListRow>().fetch_all(pool).await?;
    Ok(keyset.finish(rows))
}

/// Top-level trash items: a trashed folder stands for its trashed children.
pub async fn list_trash(pool: &PgPool, owner: &str, keyset: &Keyset) -> anyhow::Result<Page> {
    let mut qb = QueryBuilder::new(format!(
        "SELECT {LIST_COLUMNS}, NULL::timestamptz AS expires_at, f.deleted_at, f.parent_id FROM files f WHERE f.user_id = "
    ));
    qb.push_bind(owner.to_string());
    qb.push(" AND f.deleted_at IS NOT NULL AND (f.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM files p WHERE p.id = f.parent_id AND p.user_id = f.user_id AND p.deleted_at IS NOT NULL))");
    keyset.push_where(&mut qb);
    keyset.push_order(&mut qb);
    let rows = qb.build_query_as::<ListRow>().fetch_all(pool).await?;
    Ok(keyset.finish(rows))
}

/// Recently opened files, newest first (a top-N walk of idx_files_user_accessed_at).
pub async fn recent(pool: &PgPool, owner: &str, limit: i64) -> anyhow::Result<Vec<FileItem>> {
    let sql = format!(
        "SELECT {LIST_COLUMNS}, {EXPIRY_COLUMN} FROM files f {}
          WHERE f.user_id = $1 AND f.deleted_at IS NULL AND f.type = 'file'
          ORDER BY f.accessed_at DESC LIMIT $2",
        expiry_join("$1")
    );
    let rows = sqlx::query_as::<_, ListRow>(sqlx::AssertSqlSafe(sql))
        .bind(owner)
        .bind(limit.clamp(1, 50))
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(FileItem::from).collect())
}

/// Search by name: prefix matching for one or two characters, trigram similarity beyond.
pub async fn search(pool: &PgPool, owner: &str, query: &str, limit: i64) -> anyhow::Result<Vec<FileItem>> {
    let term = query.trim();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    // % and _ are LIKE wildcards; backslash is Postgres's default escape.
    let prefix = format!("{}%", term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let short = term.chars().count() <= 2;
    let (filter, order) = if short {
        (
            "lower(f.name) LIKE lower($4)",
            "CASE WHEN lower(f.name) = lower($2) THEN 1 ELSE 2 END, f.name ASC, f.modified DESC",
        )
    } else {
        (
            "(lower(f.name) LIKE lower($4) OR lower(f.name) % lower($2))",
            "CASE WHEN lower(f.name) = lower($2) THEN 1 WHEN lower(f.name) LIKE lower($4) THEN 2 ELSE 3 END,
             similarity(lower(f.name), lower($2)) DESC NULLS LAST, f.modified DESC",
        )
    };
    let sql = format!(
        "SELECT {LIST_COLUMNS}, {EXPIRY_COLUMN}, f.parent_id FROM files f {}
          WHERE f.user_id = $1 AND f.deleted_at IS NULL AND {filter}
          ORDER BY {order} LIMIT $3",
        expiry_join("$1")
    );
    let rows = sqlx::query_as::<_, ListRow>(sqlx::AssertSqlSafe(sql))
        .bind(owner)
        .bind(term)
        .bind(limit.clamp(1, 100))
        .bind(prefix)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(FileItem::from).collect())
}

pub async fn stats(pool: &PgPool, owner: &str) -> anyhow::Result<FileStats> {
    let (total_files, total_folders, shared_count, starred_count): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*) FILTER (WHERE f.type = 'file' AND f.deleted_at IS NULL),
                COUNT(*) FILTER (WHERE f.type = 'folder' AND f.deleted_at IS NULL),
                COUNT(*) FILTER (WHERE f.shared = TRUE AND f.deleted_at IS NULL
                                   AND (f.parent_id IS NULL OR parent.shared = FALSE OR parent.shared IS NULL)),
                COUNT(*) FILTER (WHERE f.starred = TRUE AND f.deleted_at IS NULL)
           FROM files f LEFT JOIN files parent ON f.parent_id = parent.id AND parent.user_id = $1
          WHERE f.user_id = $1",
    )
    .bind(owner)
    .fetch_one(pool)
    .await?;
    Ok(FileStats { total_files, total_folders, shared_count, starred_count })
}

/// Minimal facts about items, for audit names, events and ownership checks.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Brief {
    pub id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    pub item_type: String,
    pub parent_id: Option<String>,
}

impl Brief {
    pub fn kind(&self) -> ItemType {
        ItemType::parse(&self.item_type)
    }
}

pub async fn briefs(pool: &PgPool, ids: &[String], owner: &str, include_deleted: bool) -> anyhow::Result<Vec<Brief>> {
    let sql = format!(
        "SELECT id, name, type, parent_id FROM files WHERE id = ANY($1::text[]) AND user_id = $2 {}
          ORDER BY array_position($1::text[], id)",
        if include_deleted { "" } else { "AND deleted_at IS NULL" }
    );
    Ok(sqlx::query_as::<_, Brief>(sqlx::AssertSqlSafe(sql)).bind(ids).bind(owner).fetch_all(pool).await?)
}

#[derive(sqlx::FromRow)]
struct InfoRow {
    id: String,
    name: String,
    #[sqlx(rename = "type")]
    item_type: String,
    parent_id: Option<String>,
    size: Option<i64>,
    modified: DateTime<Utc>,
    accessed_at: Option<DateTime<Utc>>,
    starred: Option<bool>,
    shared: Option<bool>,
    shared_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    aggregate_size: i64,
    aggregate_file_count: i32,
    aggregate_folder_count: i32,
}

/// Get Info: the item, its location from the real parent chain, and folder totals.
pub async fn info(pool: &PgPool, id: &str, owner: &str) -> anyhow::Result<FileInfo> {
    let sql = format!(
        "SELECT f.id, f.name, f.type, f.parent_id, f.size, f.modified, f.accessed_at, f.starred, f.shared, f.shared_at,
                {EXPIRY_COLUMN}, f.aggregate_size, f.aggregate_file_count, f.aggregate_folder_count
           FROM files f {} WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NULL",
        expiry_join("$2")
    );
    let row = sqlx::query_as::<_, InfoRow>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| DomainError::NotFound("File not found".into()))?;
    let location_path = folder_path(pool, row.parent_id.as_deref(), owner).await?;
    let is_folder = row.item_type == "folder";
    Ok(FileInfo {
        id: row.id,
        name: row.name,
        item_type: ItemType::parse(&row.item_type),
        parent_id: row.parent_id,
        size: if is_folder { Some(row.aggregate_size) } else { row.size },
        modified: row.modified,
        accessed_at: row.accessed_at,
        starred: row.starred.unwrap_or(false),
        shared: row.shared.unwrap_or(false),
        shared_at: row.shared_at,
        expires_at: row.expires_at,
        location_path,
        folder_info: is_folder.then_some(FolderInfo {
            total_size: row.aggregate_size,
            file_count: row.aggregate_file_count as i64,
            folder_count: row.aggregate_folder_count as i64,
        }),
    })
}

/// Folder names from the root down to `folder_id` ("Home / A / B" without Home).
pub async fn folder_path(pool: &PgPool, folder_id: Option<&str>, owner: &str) -> anyhow::Result<Vec<String>> {
    let Some(folder_id) = folder_id else { return Ok(Vec::new()) };
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE chain(id, name, parent_id, depth, visited) AS (
           SELECT id, name, parent_id, 0, ARRAY[id] FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           UNION ALL
           SELECT f.id, f.name, f.parent_id, chain.depth + 1, chain.visited || f.id
             FROM files f JOIN chain ON chain.parent_id = f.id
            WHERE f.user_id = $2 AND f.deleted_at IS NULL AND NOT f.id = ANY(chain.visited)
         ) SELECT name FROM chain ORDER BY depth DESC",
    )
    .bind(folder_id)
    .bind(owner)
    .fetch_all(pool)
    .await?)
}

/// Breadcrumbs for a folder: (id, name) from the root down.
pub async fn folder_trail(pool: &PgPool, folder_id: &str, owner: &str) -> anyhow::Result<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "WITH RECURSIVE chain(id, name, parent_id, depth, visited) AS (
           SELECT id, name, parent_id, 0, ARRAY[id] FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           UNION ALL
           SELECT f.id, f.name, f.parent_id, chain.depth + 1, chain.visited || f.id
             FROM files f JOIN chain ON chain.parent_id = f.id
            WHERE f.user_id = $2 AND f.deleted_at IS NULL AND NOT f.id = ANY(chain.visited)
         ) SELECT id, name FROM chain ORDER BY depth DESC",
    )
    .bind(folder_id)
    .bind(owner)
    .fetch_all(pool)
    .await?)
}

pub async fn folder_name(pool: &PgPool, folder_id: Option<&str>, owner: &str) -> anyhow::Result<String> {
    let Some(id) = folder_id else { return Ok("Root".into()) };
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM files WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?;
    Ok(name.unwrap_or_else(|| "Root".into()))
}

/// The folder a paste lands in: a file target means its parent. A missing target fails.
pub async fn resolve_target_folder(pool: &PgPool, target: Option<&str>, owner: &str) -> anyhow::Result<Option<String>> {
    let Some(target) = target else { return Ok(None) };
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT type, parent_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL")
            .bind(target)
            .bind(owner)
            .fetch_optional(pool)
            .await?;
    match row {
        None => Err(DomainError::NotFound("The destination folder no longer exists".into()).into()),
        Some((t, parent)) if t == "file" => Ok(parent),
        Some(_) => Ok(Some(target.to_string())),
    }
}
