//! Files and folders. One table holds both; folders carry trigger-maintained
//! aggregates (size and counts), and every query is scoped to the owning account.

pub mod archive;
pub mod crud;
pub mod import;
pub mod listing;
pub mod ops;
pub mod orphans;
pub mod trash;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, QueryBuilder};
use tma_core::api::{FileItem, ItemType, SortBy, SortOrder};

use crate::error::DomainError;

/// The columns every listing selects, so one row type serves them all.
pub const LIST_COLUMNS: &str = "f.id, f.name, f.type,
    CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
    f.modified, f.accessed_at, f.shared_at, f.mime_type, f.starred, f.shared";

/// Share expiry of a shared item: NULL when unshared or shared without expiry.
pub fn expiry_join(owner_param: &str) -> String {
    format!(
        "LEFT JOIN LATERAL (
           SELECT BOOL_OR(sl.expires_at IS NULL) AS has_perpetual, MAX(sl.expires_at) AS expires_at
             FROM share_link_files slf JOIN share_links sl ON sl.id = slf.share_id
            WHERE slf.file_id = f.id AND sl.user_id = {owner_param}
         ) share_info ON f.shared"
    )
}

pub const EXPIRY_COLUMN: &str =
    "CASE WHEN NOT f.shared OR share_info.has_perpetual THEN NULL ELSE share_info.expires_at END AS expires_at";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ListRow {
    pub id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    pub item_type: String,
    pub size: Option<i64>,
    pub modified: DateTime<Utc>,
    pub accessed_at: Option<DateTime<Utc>>,
    pub shared_at: Option<DateTime<Utc>>,
    pub mime_type: Option<String>,
    pub starred: Option<bool>,
    pub shared: Option<bool>,
    #[sqlx(default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    pub deleted_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    pub parent_id: Option<String>,
}

impl From<ListRow> for FileItem {
    fn from(r: ListRow) -> Self {
        FileItem {
            id: r.id,
            name: r.name,
            item_type: ItemType::parse(&r.item_type),
            size: r.size,
            modified: r.modified,
            accessed_at: r.accessed_at,
            shared_at: r.shared_at,
            mime_type: r.mime_type,
            starred: r.starred.unwrap_or(false),
            shared: r.shared.unwrap_or(false),
            expires_at: r.expires_at,
            deleted_at: r.deleted_at,
            parent_id: r.parent_id,
            client_id: None,
        }
    }
}

/// A page of a listing and the cursor for the next one.
#[derive(Debug, Clone)]
pub struct Page {
    pub files: Vec<FileItem>,
    pub next_cursor: Option<String>,
}

/// Position after the last row of a page: folder-first, then the sort value, then the id.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Cursor {
    #[serde(rename = "type")]
    item_type: String,
    value: serde_json::Value,
    id: String,
}

/// Case-insensitive, numbers by value (migration 057); matches the name index.
pub const NAME_ORDER: &str = "LOWER(f.name) COLLATE tma_natural";

fn sort_expr(sort: SortBy) -> &'static str {
    match sort {
        SortBy::Name => NAME_ORDER,
        SortBy::Size => "COALESCE(CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END, 0)",
        SortBy::Modified => "f.modified",
        SortBy::AccessedAt => "f.accessed_at",
        SortBy::DeletedAt => "f.deleted_at",
    }
}

/// Keyset pagination for a listing: a stable folder-first order and a WHERE
/// clause that resumes after the cursor.
pub struct Keyset {
    pub sort: SortBy,
    pub order: SortOrder,
    pub limit: i64,
    cursor: Option<Cursor>,
}

impl Keyset {
    pub fn new(sort: SortBy, order: SortOrder, cursor: Option<&str>, limit: Option<i64>) -> Self {
        let cursor = cursor
            .and_then(|c| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c.trim_end_matches('=')).ok())
            .and_then(|bytes| serde_json::from_slice::<Cursor>(&bytes).ok())
            .filter(|c| c.item_type == "file" || c.item_type == "folder");
        Self { sort, order, limit: limit.unwrap_or(200).clamp(1, 500), cursor }
    }

    /// Append ` AND (...)` resuming after the cursor, when there is one.
    pub fn push_where(&self, qb: &mut QueryBuilder<Postgres>) {
        let Some(c) = &self.cursor else { return };
        let cmp = if self.order == SortOrder::Asc { ">" } else { "<" };
        let expr = sort_expr(self.sort);
        let push_value = |qb: &mut QueryBuilder<Postgres>| match self.sort {
            SortBy::Name => {
                qb.push("LOWER(").push_bind(c.value.as_str().unwrap_or("").to_string()).push(")");
            }
            SortBy::Size => {
                qb.push_bind(c.value.as_i64().or_else(|| c.value.as_str().and_then(|s| s.parse().ok())).unwrap_or(0));
            }
            _ => {
                let at =
                    c.value.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&Utc));
                qb.push_bind(at.unwrap_or_else(Utc::now));
            }
        };
        qb.push(" AND (f.type < ").push_bind(c.item_type.clone()).push(" OR (f.type = ").push_bind(c.item_type.clone());
        qb.push(" AND (").push(expr).push(format!(" {cmp} "));
        push_value(qb);
        qb.push(" OR (").push(expr).push(" = ");
        push_value(qb);
        qb.push(format!(" AND f.id {cmp} ")).push_bind(c.id.clone()).push("))))");
    }

    pub fn push_order(&self, qb: &mut QueryBuilder<Postgres>) {
        let dir = self.order.as_str();
        qb.push(format!(" ORDER BY f.type DESC, {} {dir}, f.id {dir} LIMIT ", sort_expr(self.sort)))
            .push_bind(self.limit + 1);
    }

    /// Trim the extra row and build the next cursor from the last one kept.
    pub fn finish(&self, rows: Vec<ListRow>) -> Page {
        let has_more = rows.len() as i64 > self.limit;
        let mut files: Vec<FileItem> = rows.into_iter().take(self.limit as usize).map(FileItem::from).collect();
        let next_cursor = if has_more {
            files.last().map(|last| {
                let value = match self.sort {
                    SortBy::Name => serde_json::Value::String(last.name.clone()),
                    SortBy::Size => serde_json::json!(last.size.unwrap_or(0)),
                    SortBy::Modified => serde_json::Value::String(last.modified.to_rfc3339()),
                    SortBy::AccessedAt => {
                        serde_json::Value::String(last.accessed_at.unwrap_or(last.modified).to_rfc3339())
                    }
                    SortBy::DeletedAt => {
                        serde_json::Value::String(last.deleted_at.unwrap_or(last.modified).to_rfc3339())
                    }
                };
                let cursor = Cursor { item_type: last.item_type.as_str().into(), value, id: last.id.clone() };
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor).unwrap_or_default())
            })
        } else {
            None
        };
        files.shrink_to_fit();
        Page { files, next_cursor }
    }
}

/// Fail unless every non-root parent is a live folder of this account.
pub async fn assert_live_folders<'e, E: sqlx::PgExecutor<'e>>(
    db: E,
    parents: &[Option<String>],
    owner: &str,
) -> anyhow::Result<()> {
    let mut ids: Vec<&str> = parents.iter().flatten().map(String::as_str).collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(());
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM files WHERE id = ANY($1::text[]) AND user_id = $2 AND type = 'folder' AND deleted_at IS NULL",
    )
    .bind(&ids)
    .bind(owner)
    .fetch_one(db)
    .await?;
    if count != ids.len() as i64 {
        return Err(DomainError::NotFound("Target folder not found".into()).into());
    }
    Ok(())
}

/// `LIKE` pattern for "name (n).ext" clashes, with wildcards escaped.
pub fn clash_pattern(name: &str, is_file: bool) -> String {
    let escape = |v: &str| v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let (stem, ext) = if is_file { tma_core::names::split_ext(name) } else { (name, "") };
    format!("{} (%){}", escape(stem), escape(ext))
}

/// The first free name for `desired` given the lowercase names already taken.
pub fn allocate_name(
    desired: &str,
    taken: &std::collections::HashSet<String>,
    is_file: bool,
) -> anyhow::Result<String> {
    if !taken.contains(&desired.to_lowercase()) {
        return Ok(desired.to_string());
    }
    for n in 1..=10_000u32 {
        let candidate = tma_core::names::numbered_name(desired, n, is_file);
        if !taken.contains(&candidate.to_lowercase()) {
            return Ok(candidate);
        }
    }
    anyhow::bail!("Too many duplicate names in database")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clash_patterns() {
        assert_eq!(clash_pattern("50%_off.pdf", true), "50\\%\\_off (%).pdf");
        assert_eq!(clash_pattern("Docs", false), "Docs (%)");
        let taken: std::collections::HashSet<String> = ["a.txt".into(), "a (1).txt".into()].into();
        assert_eq!(allocate_name("A.txt", &taken, true).unwrap(), "A (2).txt");
    }

    #[test]
    fn cursor_round_trip() {
        let ks = Keyset::new(SortBy::Name, SortOrder::Asc, None, Some(1));
        let row = |id: &str| ListRow {
            id: id.into(),
            name: id.into(),
            item_type: "file".into(),
            size: Some(1),
            modified: Utc::now(),
            accessed_at: None,
            shared_at: None,
            mime_type: None,
            starred: None,
            shared: None,
            expires_at: None,
            deleted_at: None,
            parent_id: None,
        };
        let page = ks.finish(vec![row("a"), row("b")]);
        assert_eq!(page.files.len(), 1);
        let next = Keyset::new(SortBy::Name, SortOrder::Asc, page.next_cursor.as_deref(), Some(1));
        assert!(next.cursor.is_some());
    }
}
