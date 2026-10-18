//! Accounts: identity, credentials, token versions and the account context
//! (the owner whose files a login identity acts on).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::cache::{self, DEFAULT_TTL};
use crate::state::AppState;
use crate::util::generate_id;

/// What the login path needs, including the password hash. Never cached.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuthRow {
    pub id: String,
    pub email: String,
    pub password: Option<String>,
    pub name: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub mfa_enabled: Option<bool>,
}

/// The public profile, cached by id.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProfileRow {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub token_version: i32,
    pub created_at: Option<DateTime<Utc>>,
    pub mfa_enabled: Option<bool>,
}

/// Which account an identity acts under and what it may do there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub owner_id: String,
    pub permissions: Vec<String>,
    pub is_sub_user: bool,
}

pub async fn by_email(pool: &PgPool, email: &str) -> anyhow::Result<Option<AuthRow>> {
    Ok(sqlx::query_as::<_, AuthRow>(
        "SELECT id, email, password, name, created_at, mfa_enabled FROM users WHERE email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?)
}

pub async fn by_id(state: &AppState, id: &str) -> anyhow::Result<Option<ProfileRow>> {
    let key = cache::keys::user_by_id(id);
    if let Some(row) = state.cache.get::<ProfileRow>(&key).await {
        return Ok(Some(row));
    }
    let row = sqlx::query_as::<_, ProfileRow>(
        "SELECT id, email, name, token_version, created_at, mfa_enabled FROM users WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(row) = &row {
        state.cache.fill(&key, row, DEFAULT_TTL * 2).await;
    }
    Ok(row)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PasswordRow {
    pub id: String,
    pub email: String,
    pub password: Option<String>,
    pub name: Option<String>,
}

pub async fn with_password(pool: &PgPool, id: &str) -> anyhow::Result<Option<PasswordRow>> {
    Ok(sqlx::query_as::<_, PasswordRow>("SELECT id, email, password, name FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?)
}

pub async fn token_version(state: &AppState, id: &str) -> anyhow::Result<Option<i32>> {
    let key = cache::keys::token_version(id);
    if let Some(v) = state.cache.get::<i32>(&key).await {
        return Ok(Some(v));
    }
    let v: Option<i32> = sqlx::query_scalar("SELECT token_version FROM users WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    if let Some(v) = v {
        state.cache.fill(&key, &v, DEFAULT_TTL).await;
    }
    Ok(v)
}

pub async fn account(state: &AppState, id: &str) -> anyhow::Result<Option<Account>> {
    let key = cache::keys::account(id);
    if let Some(a) = state.cache.get::<Account>(&key).await {
        return Ok(Some(a));
    }
    let row: Option<(String, Option<String>, Vec<String>)> =
        sqlx::query_as("SELECT id, parent_user_id, permissions FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((id, parent, permissions)) = row else { return Ok(None) };
    let is_sub_user = parent.is_some();
    let account = Account {
        owner_id: parent.unwrap_or_else(|| id.clone()),
        id,
        // Owners are never checked against this list.
        permissions: if is_sub_user { tma_core::permissions::normalize(&permissions) } else { Vec::new() },
        is_sub_user,
    };
    state.cache.fill(&key, &account, DEFAULT_TTL * 2).await;
    Ok(Some(account))
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct NewUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub mfa_enabled: Option<bool>,
}

pub async fn create(state: &AppState, email: &str, hash: &str, name: Option<&str>) -> anyhow::Result<NewUser> {
    let user = sqlx::query_as::<_, NewUser>(
        "INSERT INTO users(id, email, password, name) VALUES($1,$2,$3,$4) RETURNING id, email, name, created_at, mfa_enabled",
    )
    .bind(generate_id())
    .bind(email)
    .bind(hash)
    .bind(name)
    .fetch_one(&state.pool)
    .await?;
    Ok(user)
}

pub async fn set_password(state: &AppState, user_id: &str, hash: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET password = $1 WHERE id = $2").bind(hash).bind(user_id).execute(&state.pool).await?;
    state.cache.invalidate(&[cache::keys::user_by_id(user_id)]).await;
    Ok(())
}

/// Bump the token version so every issued token stops working.
pub async fn invalidate_all_sessions(state: &AppState, user_id: &str) -> anyhow::Result<i32> {
    let v: i32 = sqlx::query_scalar(
        "UPDATE users SET token_version = token_version + 1, last_token_invalidation = NOW() WHERE id = $1 RETURNING token_version",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("User not found"))?;
    state.cache.invalidate(&[cache::keys::user_by_id(user_id), cache::keys::token_version(user_id)]).await;
    tracing::info!(user_id, "All user sessions invalidated");
    Ok(v)
}

/// Bytes the account stores (trashed files included), from the maintained counter.
pub async fn storage_used(pool: &PgPool, user_id: &str) -> anyhow::Result<i64> {
    let used: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(account.storage_used, 0) FROM users actor
           JOIN users account ON account.id = COALESCE(actor.parent_user_id, actor.id)
          WHERE actor.id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(used.unwrap_or(0))
}

pub async fn storage_limit(pool: &PgPool, user_id: &str) -> anyhow::Result<Option<i64>> {
    let row: Option<Option<i64>> =
        sqlx::query_scalar("SELECT storage_limit FROM users WHERE id = $1").bind(user_id).fetch_optional(pool).await?;
    Ok(row.flatten())
}

/// After the very first account is created: record it as the first user and close signup.
pub async fn handle_first_user_setup(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&state.pool).await?;
    if count == 1 {
        let updated = sqlx::query(
            "UPDATE app_settings SET first_user_id = $1, signup_enabled = false, updated_at = NOW()
              WHERE id = 'app_settings' AND first_user_id IS NULL",
        )
        .bind(user_id)
        .execute(&state.pool)
        .await?
        .rows_affected();
        if updated == 0 {
            sqlx::query("UPDATE app_settings SET signup_enabled = false, updated_at = NOW() WHERE id = 'app_settings'")
                .execute(&state.pool)
                .await?;
        }
        tracing::info!(user_id, "First user created, signup disabled by default");
        state.settings_changed().await;
    }
    Ok(())
}

/// Forget every cached fact about an identity; its sessions go with their rows.
pub async fn forget(state: &AppState, user_id: &str) {
    let id = user_id;
    state
        .cache
        .invalidate(&[cache::keys::user_by_id(id), cache::keys::token_version(id), cache::keys::account(id)])
        .await;
}
