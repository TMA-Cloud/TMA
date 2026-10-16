//! Account administration: the first user's user list and storage limits, and
//! each owner's sub-users. A sub-user acts on its owner's files and quota.

use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tma_core::api::{AdminUser, SubUser};

use crate::error::DomainError;
use crate::util::generate_id;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserCursor {
    created_at: DateTime<Utc>,
    id: String,
}

#[derive(sqlx::FromRow)]
struct AdminRow {
    id: String,
    email: String,
    name: Option<String>,
    created_at: Option<DateTime<Utc>>,
    mfa_enabled: Option<bool>,
    storage_limit: Option<i64>,
    parent_user_id: Option<String>,
    permissions: Vec<String>,
    storage_used: i64,
}

/// A page of complete accounts: each owner followed by its sub-users.
pub async fn list_users(
    pool: &PgPool,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> anyhow::Result<(Vec<AdminUser>, Option<String>)> {
    let page = limit.unwrap_or(50).clamp(1, 100);
    let decoded: Option<UserCursor> = cursor
        .and_then(|c| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok());
    let owners: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, created_at FROM users WHERE parent_user_id IS NULL
           AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::text))
         ORDER BY created_at, id LIMIT $3",
    )
    .bind(decoded.as_ref().map(|c| c.created_at))
    .bind(decoded.as_ref().map(|c| c.id.clone()))
    .bind(page + 1)
    .fetch_all(pool)
    .await?;
    let has_more = owners.len() as i64 > page;
    let owners: Vec<(String, DateTime<Utc>)> = owners.into_iter().take(page as usize).collect();
    if owners.is_empty() {
        return Ok((Vec::new(), None));
    }
    let ids: Vec<&str> = owners.iter().map(|o| o.0.as_str()).collect();
    let rows = sqlx::query_as::<_, AdminRow>(
        "SELECT u.id, u.email, u.name, u.created_at, u.mfa_enabled, u.storage_limit, u.parent_user_id, u.permissions,
                COALESCE(account.storage_used, 0) AS storage_used
           FROM users u JOIN users account ON account.id = COALESCE(u.parent_user_id, u.id)
          WHERE account.id = ANY($1::text[])
          ORDER BY array_position($1::text[], account.id), u.parent_user_id NULLS FIRST, u.created_at ASC",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let limit_of = |account: &str| {
        rows.iter().find(|r| r.id == account && r.parent_user_id.is_none()).and_then(|r| r.storage_limit)
    };
    let users = rows
        .iter()
        .map(|r| {
            let account = r.parent_user_id.as_deref().unwrap_or(&r.id);
            AdminUser {
                id: r.id.clone(),
                email: r.email.clone(),
                name: r.name.clone(),
                created_at: r.created_at.unwrap_or_else(Utc::now),
                mfa_enabled: r.mfa_enabled.unwrap_or(false),
                storage_limit: r.storage_limit,
                storage_used: r.storage_used,
                storage_total: limit_of(account),
                parent_user_id: r.parent_user_id.clone(),
                permissions: r.parent_user_id.as_ref().map(|_| r.permissions.clone()),
            }
        })
        .collect();
    let next = if has_more {
        owners.last().map(|(id, at)| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&UserCursor { created_at: *at, id: id.clone() }).unwrap_or_default())
        })
    } else {
        None
    };
    Ok((users, next))
}

pub async fn total_users(pool: &PgPool) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(pool).await?)
}

/// Set an owner's storage limit; never below what the account already stores.
pub async fn set_storage_limit(pool: &PgPool, admin_id: &str, target: &str, limit: Option<i64>) -> anyhow::Result<()> {
    const PETABYTE: i64 = 1024 * 1024 * 1024 * 1024 * 1024;
    if let Some(l) = limit {
        if l <= 0 {
            return Err(DomainError::BadRequest("Storage limit must be a positive integer or null".into()).into());
        }
        if l > PETABYTE {
            return Err(DomainError::BadRequest("Storage limit cannot exceed 1 Petabyte".into()).into());
        }
    }
    if target.is_empty() || !target.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(DomainError::BadRequest("Invalid targetUserId format".into()).into());
    }
    let mut tx = pool.begin().await?;
    crate::settings::verify_first_user(&mut tx, admin_id, "set storage limits").await?;
    let row: Option<(Option<String>, i64, i64)> =
        sqlx::query_as("SELECT parent_user_id, storage_used, storage_reserved FROM users WHERE id = $1 FOR UPDATE")
            .bind(target)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((parent, used, reserved)) = row else {
        return Err(DomainError::BadRequest("User not found".into()).into());
    };
    if parent.is_some() {
        return Err(DomainError::BadRequest(
            "Sub-users share their owner's storage limit; set the limit on the owner account instead".into(),
        )
        .into());
    }
    if let Some(l) = limit
        && l < used + reserved
    {
        return Err(DomainError::BadRequest(format!(
            "Storage limit ({}) is below the {} this account already stores",
            tma_core::format::file_size(l),
            tma_core::format::file_size(used)
        ))
        .into());
    }
    sqlx::query("UPDATE users SET storage_limit = $1 WHERE id = $2").bind(limit).bind(target).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct SubUserRow {
    id: String,
    email: String,
    name: Option<String>,
    permissions: Vec<String>,
    created_at: Option<DateTime<Utc>>,
    mfa_enabled: Option<bool>,
}

impl From<SubUserRow> for SubUser {
    fn from(r: SubUserRow) -> Self {
        SubUser {
            id: r.id,
            email: r.email,
            name: r.name,
            permissions: tma_core::permissions::normalize(&r.permissions),
            created_at: r.created_at.unwrap_or_else(Utc::now),
            mfa_enabled: r.mfa_enabled.unwrap_or(false),
        }
    }
}

const SUB_USER_COLUMNS: &str = "id, email, name, permissions, created_at, mfa_enabled";

pub async fn list_sub_users(pool: &PgPool, owner: &str) -> anyhow::Result<Vec<SubUser>> {
    let sql = format!("SELECT {SUB_USER_COLUMNS} FROM users WHERE parent_user_id = $1 ORDER BY created_at ASC");
    Ok(sqlx::query_as::<_, SubUserRow>(sqlx::AssertSqlSafe(sql))
        .bind(owner)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

pub async fn get_sub_user(pool: &PgPool, owner: &str, id: &str) -> anyhow::Result<Option<SubUser>> {
    let sql = format!("SELECT {SUB_USER_COLUMNS} FROM users WHERE id = $1 AND parent_user_id = $2");
    Ok(sqlx::query_as::<_, SubUserRow>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .map(Into::into))
}

/// Create a sub-user; the owner row is locked so it cannot become a sub-user meanwhile.
pub async fn create_sub_user(
    pool: &PgPool,
    owner: &str,
    email: &str,
    hash: &str,
    name: &str,
    permissions: &[String],
) -> anyhow::Result<SubUser> {
    if !tma_core::permissions::all_valid(permissions) {
        return Err(DomainError::BadRequest("Invalid sub-user permissions".into()).into());
    }
    let name = name.trim();
    if name.is_empty() {
        return Err(DomainError::BadRequest("Sub-user name is required".into()).into());
    }
    let grants = tma_core::permissions::normalize(permissions);
    let mut tx = pool.begin().await?;
    let parent: Option<Option<String>> =
        sqlx::query_scalar("SELECT parent_user_id FROM users WHERE id = $1 FOR UPDATE")
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    match parent {
        None => return Err(DomainError::NotFound("Owner account not found".into()).into()),
        Some(Some(_)) => return Err(DomainError::Forbidden("Sub-users cannot create sub-users".into()).into()),
        Some(None) => {}
    }
    let sql = format!(
        "INSERT INTO users(id, email, password, name, parent_user_id, permissions) VALUES($1, $2, $3, $4, $5, $6) RETURNING {SUB_USER_COLUMNS}"
    );
    let row = sqlx::query_as::<_, SubUserRow>(sqlx::AssertSqlSafe(sql))
        .bind(generate_id())
        .bind(email)
        .bind(hash)
        .bind(name)
        .bind(owner)
        .bind(&grants)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(row.into())
}

pub async fn update_sub_user(
    pool: &PgPool,
    owner: &str,
    id: &str,
    permissions: &[String],
) -> anyhow::Result<Option<SubUser>> {
    if !tma_core::permissions::all_valid(permissions) {
        return Err(DomainError::BadRequest("Invalid sub-user permissions".into()).into());
    }
    let grants = tma_core::permissions::normalize(permissions);
    let sql =
        format!("UPDATE users SET permissions = $1 WHERE id = $2 AND parent_user_id = $3 RETURNING {SUB_USER_COLUMNS}");
    Ok(sqlx::query_as::<_, SubUserRow>(sqlx::AssertSqlSafe(sql))
        .bind(&grants)
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .map(Into::into))
}

pub async fn delete_sub_user(pool: &PgPool, owner: &str, id: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query("DELETE FROM users WHERE id = $1 AND parent_user_id = $2")
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?
        .rows_affected()
        > 0)
}

#[derive(sqlx::FromRow)]
struct ClientRow {
    id: String,
    user_id: String,
    user_name: Option<String>,
    user_email: Option<String>,
    app_version: String,
    platform: Option<String>,
    ip_address: Option<String>,
    last_seen_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

/// Desktop apps seen within the window (web presence excluded).
pub async fn active_clients(pool: &PgPool, within_minutes: i64) -> anyhow::Result<Vec<tma_core::api::ActiveClient>> {
    let rows = sqlx::query_as::<_, ClientRow>(
        "SELECT h.id, h.user_id, u.name AS user_name, u.email AS user_email, h.app_version, h.platform, h.ip_address, h.last_seen_at, h.created_at
           FROM client_heartbeats h JOIN users u ON u.id = h.user_id
          WHERE h.last_seen_at > NOW() - INTERVAL '1 minute' * $1 AND h.platform IS DISTINCT FROM 'web'
          ORDER BY h.last_seen_at DESC",
    )
    .bind(within_minutes as f64)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| tma_core::api::ActiveClient {
            id: r.id,
            user_id: r.user_id,
            user_name: r.user_name,
            user_email: r.user_email,
            app_version: r.app_version,
            platform: r.platform,
            ip_address: r.ip_address,
            last_seen_at: r.last_seen_at,
            connected_since: r.created_at,
        })
        .collect())
}
