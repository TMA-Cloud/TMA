//! Public share links. A link points at a root item; every item in the root's
//! subtree is a member (`share_link_files`), so the public page can never reach
//! outside it. Items added to a shared folder later are linked by a job.

use std::collections::BTreeMap;

use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tma_core::api::{ItemType, SharedItem, SharedPage};

use crate::cache::{self, Cache, DEFAULT_TTL};
use crate::util::generate_id;

/// Create or extend links for the roots and add their whole subtrees in one statement.
/// Returns tokens by root, member counts, and the roots that got a new link.
pub async fn upsert_roots(
    pool: &PgPool,
    roots: &[String],
    owner: &str,
    expires_at: Option<DateTime<Utc>>,
) -> anyhow::Result<(BTreeMap<String, String>, BTreeMap<String, i64>, Vec<String>)> {
    let mut tx = pool.begin().await?;
    // Serialises share creation for the account: the schema allows several links per root.
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE").bind(owner).execute(&mut *tx).await?;
    let existing: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT ON (file_id) file_id, id FROM share_links WHERE user_id = $1 AND file_id = ANY($2::text[]) ORDER BY file_id, created_at, id",
    )
    .bind(owner)
    .bind(roots)
    .fetch_all(&mut *tx)
    .await?;
    let mut tokens: BTreeMap<String, String> = existing.into_iter().collect();
    let mut created = Vec::new();
    for root in roots {
        if !tokens.contains_key(root) {
            tokens.insert(root.clone(), generate_id());
            created.push(root.clone());
        }
    }
    let share_ids: Vec<String> = roots.iter().map(|r| tokens.get(r).cloned().unwrap_or_default()).collect();
    let counts: Vec<(String, String, i64)> = sqlx::query_as(
        "WITH RECURSIVE mapping(root_id, share_id) AS (
           SELECT u.root_id, u.share_id FROM unnest($1::text[], $2::text[]) AS u(root_id, share_id)
             JOIN files f ON f.id = u.root_id AND f.user_id = $3 AND f.deleted_at IS NULL
         ), inserted_links AS (
           INSERT INTO share_links(id, file_id, user_id, expires_at)
           SELECT m.share_id, m.root_id, $3, $4 FROM mapping m WHERE NOT EXISTS (SELECT 1 FROM share_links sl WHERE sl.id = m.share_id)
           RETURNING id
         ), updated_links AS (
           UPDATE share_links sl SET expires_at = $4 FROM mapping m WHERE sl.id = m.share_id RETURNING sl.id
         ), tree(root_id, id, visited) AS (
           SELECT f.id, f.id, ARRAY[f.id] FROM files f WHERE f.id = ANY($1::text[]) AND f.user_id = $3 AND f.deleted_at IS NULL
           UNION ALL
           SELECT tree.root_id, child.id, tree.visited || child.id FROM files child JOIN tree ON child.parent_id = tree.id
            WHERE child.user_id = $3 AND child.deleted_at IS NULL AND NOT child.id = ANY(tree.visited)
         ), updated_files AS (
           UPDATE files f SET shared = TRUE, shared_at = COALESCE(shared_at, NOW()) FROM tree WHERE f.id = tree.id AND f.user_id = $3 RETURNING f.id
         ), linked AS (
           INSERT INTO share_link_files(share_id, file_id) SELECT m.share_id, tree.id FROM tree JOIN mapping m ON m.root_id = tree.root_id
           ON CONFLICT DO NOTHING RETURNING share_id
         )
         SELECT m.root_id, m.share_id, COUNT(tree.id) FROM mapping m LEFT JOIN tree ON tree.root_id = m.root_id GROUP BY m.root_id, m.share_id",
    )
    .bind(roots)
    .bind(&share_ids)
    .bind(owner)
    .bind(expires_at)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((tokens, counts.into_iter().map(|(root, _, n)| (root, n)).collect(), created))
}

/// The link token of each item that is a share root.
pub async fn links_for(pool: &PgPool, ids: &[String], owner: &str) -> anyhow::Result<BTreeMap<String, String>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT DISTINCT ON (file_id) file_id, id FROM share_links WHERE file_id = ANY($1::text[]) AND user_id = $2 ORDER BY file_id, created_at")
            .bind(ids)
            .bind(owner)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().collect())
}

/// Remove the roots' trees from every share; returns the tokens affected.
pub async fn unshare_roots(pool: &PgPool, roots: &[String], owner: &str) -> anyhow::Result<Vec<String>> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "CREATE TEMP TABLE unshare_stage ON COMMIT DROP AS
         WITH RECURSIVE tree(id, visited) AS (
           SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2
           UNION ALL
           SELECT child.id, tree.visited || child.id FROM files child JOIN tree ON child.parent_id = tree.id
            WHERE child.user_id = $2 AND NOT child.id = ANY(tree.visited)
         ) SELECT DISTINCT id FROM tree",
    )
    .bind(roots)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    let affected: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT slf.share_id FROM share_link_files slf JOIN share_links sl ON sl.id = slf.share_id
          WHERE sl.user_id = $1 AND slf.file_id IN (SELECT id FROM unshare_stage)",
    )
    .bind(owner)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM share_link_files slf USING share_links sl WHERE slf.share_id = sl.id AND sl.user_id = $1
            AND slf.file_id IN (SELECT id FROM unshare_stage)",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM share_links WHERE user_id = $1 AND file_id = ANY($2::text[])")
        .bind(owner)
        .bind(roots)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE files f SET shared = EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id),
                shared_at = CASE WHEN EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id) THEN COALESCE(f.shared_at, NOW()) END
          WHERE f.user_id = $1 AND f.id IN (SELECT id FROM unshare_stage)",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(affected)
}

/// One indexed lookup: is this folder itself a member of any share?
pub async fn parent_has_shares(pool: &PgPool, parent: &str, owner: &str) -> anyhow::Result<bool> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM share_link_files slf JOIN share_links sl ON sl.id = slf.share_id AND sl.user_id = $2 WHERE slf.file_id = $1 LIMIT 1",
    )
    .bind(parent)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// Add items (and their subtrees) to every share containing their parent.
/// Returns (root id, share id) pairs that changed.
pub async fn link_to_parent_shares(
    pool: &PgPool,
    roots: &[String],
    owner: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "CREATE TEMP TABLE link_stage ON COMMIT DROP AS
         WITH RECURSIVE r(root_id, id, parent_id, visited) AS (
           SELECT f.id, f.id, f.parent_id, ARRAY[f.id] FROM files f WHERE f.id = ANY($1::text[]) AND f.user_id = $2 AND f.deleted_at IS NULL
           UNION ALL
           SELECT r.root_id, child.id, child.parent_id, r.visited || child.id FROM files child JOIN r ON child.parent_id = r.id
            WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(r.visited)
         ), parent_shares AS (
           SELECT root.id AS root_id, slf.share_id FROM files root
             JOIN share_link_files slf ON slf.file_id = root.parent_id
             JOIN share_links sl ON sl.id = slf.share_id AND sl.user_id = $2
            WHERE root.id = ANY($1::text[]) AND root.user_id = $2
         ) SELECT DISTINCT r.root_id, r.id AS file_id, parent_shares.share_id FROM r JOIN parent_shares ON parent_shares.root_id = r.root_id",
    )
    .bind(roots)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO share_link_files(share_id, file_id) SELECT share_id, file_id FROM link_stage ON CONFLICT DO NOTHING").execute(&mut *tx).await?;
    sqlx::query("UPDATE files f SET shared = TRUE, shared_at = COALESCE(shared_at, NOW()) WHERE f.user_id = $1 AND f.id IN (SELECT file_id FROM link_stage)")
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    let mappings: Vec<(String, String)> =
        sqlx::query_as("SELECT DISTINCT root_id, share_id FROM link_stage ORDER BY root_id, share_id")
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok(mappings)
}

/// The root a token points at.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SharedRoot {
    pub id: String,
    pub name: String,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub item_type: String,
    pub mime_type: Option<String>,
    pub size: Option<i64>,
    pub path: Option<String>,
    pub user_id: String,
    pub expires_at: Option<DateTime<Utc>>,
}

pub enum TokenLookup {
    Found(SharedRoot),
    Expired,
    Missing,
}

/// Resolve a token; the cached entry never outlives the link's expiry.
pub async fn by_token(pool: &PgPool, cache: &Cache, token: &str) -> anyhow::Result<TokenLookup> {
    let key = cache::keys::share_by_token(token);
    let now = Utc::now();
    if let Some(root) = cache.get::<SharedRoot>(&key).await {
        if root.expires_at.is_some_and(|e| e < now) {
            cache.invalidate(&[key]).await;
            return Ok(TokenLookup::Expired);
        }
        return Ok(TokenLookup::Found(root));
    }
    let root = sqlx::query_as::<_, SharedRoot>(
        "SELECT f.id, f.name, f.type, f.mime_type, f.size, f.path, f.user_id, s.expires_at
           FROM share_links s JOIN files f ON s.file_id = f.id AND f.user_id = s.user_id
          WHERE s.id = $1 AND f.deleted_at IS NULL",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    let Some(root) = root else { return Ok(TokenLookup::Missing) };
    if root.expires_at.is_some_and(|e| e < now) {
        return Ok(TokenLookup::Expired);
    }
    let ttl = root.expires_at.map(|e| ((e - now).num_seconds().max(1) as u64).min(DEFAULT_TTL)).unwrap_or(DEFAULT_TTL);
    cache.fill(&key, &root, ttl).await;
    Ok(TokenLookup::Found(root))
}

pub async fn forget_tokens<T: AsRef<str>>(cache: &Cache, tokens: impl IntoIterator<Item = T>) {
    let keys: Vec<String> = tokens.into_iter().map(|t| cache::keys::share_by_token(t.as_ref())).collect();
    cache.invalidate(&keys).await;
}

#[derive(Serialize, Deserialize)]
struct PageCursor {
    rank: i32,
    name: String,
    id: String,
}

#[derive(sqlx::FromRow)]
struct SharedRow {
    id: String,
    name: String,
    #[sqlx(rename = "type")]
    item_type: String,
    mime_type: Option<String>,
    size: Option<i64>,
    sort_rank: i32,
}

/// One page of a shared folder, folders first then by name.
pub async fn folder_page(
    pool: &PgPool,
    token: &str,
    folder_id: &str,
    cursor: Option<&str>,
    limit: Option<i64>,
) -> anyhow::Result<SharedPage> {
    let limit = limit.unwrap_or(100).clamp(1, 200);
    let decoded: Option<PageCursor> = cursor
        .and_then(|c| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    let rows = sqlx::query_as::<_, SharedRow>(
        "SELECT f.id, f.name, f.type, f.mime_type, CASE WHEN f.type = 'folder' THEN f.aggregate_size ELSE f.size END AS size,
                CASE WHEN f.type = 'folder' THEN 0 ELSE 1 END AS sort_rank
           FROM share_link_files s JOIN files f ON s.file_id = f.id
          WHERE s.share_id = $1 AND f.parent_id = $2 AND f.deleted_at IS NULL
            AND ($3::integer IS NULL OR (CASE WHEN f.type = 'folder' THEN 0 ELSE 1 END, LOWER(f.name), f.id) > ($3, $4, $5))
          ORDER BY sort_rank, LOWER(f.name), f.id LIMIT $6",
    )
    .bind(token)
    .bind(folder_id)
    .bind(decoded.as_ref().map(|c| c.rank))
    .bind(decoded.as_ref().map(|c| c.name.clone()))
    .bind(decoded.as_ref().map(|c| c.id.clone()))
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let kept: Vec<SharedRow> = rows.into_iter().take(limit as usize).collect();
    let next_cursor = if has_more {
        kept.last().map(|last| {
            let c = PageCursor { rank: last.sort_rank, name: last.name.to_lowercase(), id: last.id.clone() };
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap_or_default())
        })
    } else {
        None
    };
    let items = kept
        .into_iter()
        .map(|r| SharedItem {
            id: r.id,
            name: r.name,
            item_type: ItemType::parse(&r.item_type),
            mime_type: r.mime_type,
            size: r.size,
        })
        .collect();
    Ok(SharedPage { items, next_cursor })
}

/// Breadcrumbs inside a share, root to folder; empty when the folder is not a member.
pub async fn folder_trail(
    pool: &PgPool,
    token: &str,
    folder_id: &str,
) -> anyhow::Result<Vec<(String, String, String)>> {
    let mut rows: Vec<(String, String, String)> = sqlx::query_as(
        "WITH RECURSIVE up(id, name, type, parent_id, visited) AS (
           SELECT f.id, f.name, f.type, f.parent_id, ARRAY[f.id] FROM files f JOIN share_link_files slf ON slf.file_id = f.id
            WHERE slf.share_id = $1 AND f.id = $2 AND f.deleted_at IS NULL
           UNION ALL
           SELECT f.id, f.name, f.type, f.parent_id, up.visited || f.id FROM files f
             JOIN share_link_files slf ON slf.file_id = f.id JOIN up ON up.parent_id = f.id
            WHERE slf.share_id = $1 AND f.deleted_at IS NULL AND NOT f.id = ANY(up.visited)
         ) SELECT id, name, type FROM up",
    )
    .bind(token)
    .bind(folder_id)
    .fetch_all(pool)
    .await?;
    rows.reverse();
    Ok(rows)
}

/// A member item of a share, for the shared download route.
pub async fn member(
    pool: &PgPool,
    token: &str,
    id: &str,
) -> anyhow::Result<Option<crate::models::files::crud::StoredFile>> {
    Ok(sqlx::query_as(
        "SELECT f.id, f.name, f.type, f.size, f.mime_type, f.path, f.parent_id, f.dek_wrapped, f.dek_kek_version, f.modified
           FROM files f JOIN share_link_files slf ON slf.file_id = f.id AND slf.share_id = $1 WHERE f.id = $2 AND f.deleted_at IS NULL",
    )
    .bind(token)
    .bind(id)
    .fetch_optional(pool)
    .await?)
}

/// Delete expired links and clear the shared flag where no link is left.
pub async fn cleanup_expired(pool: &PgPool, cache: &Cache) -> anyhow::Result<u64> {
    let mut total = 0;
    for _ in 0..100 {
        let mut tx = pool.begin().await?;
        let expired: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, file_id, user_id FROM share_links WHERE expires_at IS NOT NULL AND expires_at < NOW()
              ORDER BY expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED",
        )
        .fetch_all(&mut *tx)
        .await?;
        if expired.is_empty() {
            tx.commit().await?;
            break;
        }
        let ids: Vec<&str> = expired.iter().map(|r| r.0.as_str()).collect();
        // Every member, not just the roots: descendants carry the shared flag too.
        let members: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT file_id FROM share_link_files WHERE share_id = ANY($1::text[])")
                .bind(&ids)
                .fetch_all(&mut *tx)
                .await?;
        sqlx::query("DELETE FROM share_links WHERE id = ANY($1::text[])").bind(&ids).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE files f SET shared = EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id),
                    shared_at = CASE WHEN EXISTS (SELECT 1 FROM share_link_files slf WHERE slf.file_id = f.id) THEN f.shared_at END
              WHERE f.id = ANY($1::text[]) OR f.id = ANY($2::text[])",
        )
        .bind(&members)
        .bind(expired.iter().map(|r| r.1.clone()).collect::<Vec<_>>())
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        total += ids.len() as u64;
        forget_tokens(cache, &ids).await;
        if ids.len() < 500 {
            break;
        }
    }
    tracing::info!(count = total, "[ShareCleanup] Cleaned up expired share links");
    Ok(total)
}
