//! Two-factor authentication: the TOTP secret, replay protection and backup codes.

use sqlx::PgPool;

use crate::auth::{password, totp};
use crate::cache;
use crate::state::AppState;
use crate::util::generate_id;

const BACKUP_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REGENERATION_COOLDOWN_SECS: i64 = 300;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MfaState {
    pub mfa_enabled: Option<bool>,
    pub mfa_secret: Option<String>,
    pub mfa_last_time_step: Option<i64>,
}

impl MfaState {
    pub fn enabled(&self) -> bool {
        self.mfa_enabled == Some(true)
    }
}

pub async fn state(pool: &PgPool, user_id: &str) -> anyhow::Result<Option<MfaState>> {
    Ok(sqlx::query_as("SELECT mfa_enabled, mfa_secret, mfa_last_time_step FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(pool)
        .await?)
}

/// Store a new secret; resetting the replay counter, since old steps mean nothing now.
pub async fn set_secret(state: &AppState, user_id: &str, secret: &str, enabled: bool) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET mfa_secret = $1, mfa_enabled = $2, mfa_last_time_step = NULL WHERE id = $3")
        .bind(secret)
        .bind(enabled)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    state.cache.invalidate(&[cache::keys::user_by_id(user_id)]).await;
    Ok(())
}

pub async fn enable(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE users SET mfa_enabled = TRUE WHERE id = $1").bind(user_id).execute(&state.pool).await?;
    state.cache.invalidate(&[cache::keys::user_by_id(user_id)]).await;
    Ok(())
}

pub async fn disable(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_last_time_step = NULL WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.cache.invalidate(&[cache::keys::user_by_id(user_id)]).await;
    Ok(())
}

/// Claim a time step in one conditional UPDATE, so concurrent logins with one stolen code cannot all pass.
async fn consume_step(pool: &PgPool, user_id: &str, step: i64) -> anyhow::Result<bool> {
    let updated = sqlx::query("UPDATE users SET mfa_last_time_step = $2 WHERE id = $1 AND (mfa_last_time_step IS NULL OR mfa_last_time_step < $2)")
        .bind(user_id)
        .bind(step)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(updated > 0)
}

/// Verify a TOTP code and spend its step.
pub async fn verify_totp(
    pool: &PgPool,
    user_id: &str,
    secret: &str,
    last_step: Option<i64>,
    code: &str,
) -> anyhow::Result<bool> {
    let Some(step) = totp::verify(secret, code, last_step) else { return Ok(false) };
    if !consume_step(pool, user_id, step).await? {
        tracing::warn!(user_id, step, "Rejected replay of an already-used MFA code");
        return Ok(false);
    }
    Ok(true)
}

/// A TOTP code or an unused backup code, for sign-in and sensitive changes.
pub async fn verify_code(pool: &PgPool, user_id: &str, code: &str) -> anyhow::Result<bool> {
    let Some(st) = state(pool, user_id).await? else { return Ok(false) };
    let (true, Some(secret)) = (st.enabled(), st.mfa_secret.as_deref()) else { return Ok(false) };
    if verify_totp(pool, user_id, secret, st.mfa_last_time_step, code).await? {
        return Ok(true);
    }
    consume_backup_code(pool, user_id, code).await
}

fn mint_codes(count: usize) -> Vec<String> {
    (0..count)
        .map(|_| {
            let bytes = crate::crypto::random_bytes::<8>();
            bytes.iter().map(|b| BACKUP_ALPHABET[*b as usize % BACKUP_ALPHABET.len()] as char).collect()
        })
        .collect()
}

async fn hash_codes(codes: &[String]) -> anyhow::Result<Vec<String>> {
    let mut hashes = Vec::with_capacity(codes.len());
    for code in codes {
        hashes.push(password::hash(code).await?);
    }
    Ok(hashes)
}

/// Replace a user's backup codes; hashing happens before the transaction so it holds no lock for a second.
pub async fn replace_backup_codes(pool: &PgPool, user_id: &str, count: usize) -> anyhow::Result<Vec<String>> {
    let codes = mint_codes(count);
    let hashes = hash_codes(&codes).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM mfa_backup_codes WHERE user_id = $1").bind(user_id).execute(&mut *tx).await?;
    for hash in hashes {
        sqlx::query("INSERT INTO mfa_backup_codes(id, user_id, code_hash) VALUES($1, $2, $3)")
            .bind(generate_id())
            .bind(user_id)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(codes)
}

async fn consume_backup_code(pool: &PgPool, user_id: &str, code: &str) -> anyhow::Result<bool> {
    if code.is_empty() {
        return Ok(false);
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, code_hash FROM mfa_backup_codes WHERE user_id = $1 AND used = FALSE")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    for (id, hash) in rows {
        if password::verify(code, &hash).await {
            // `used` is re-checked: a concurrent login may have spent it during the slow compare.
            let claimed =
                sqlx::query("UPDATE mfa_backup_codes SET used = TRUE, used_at = NOW() WHERE id = $1 AND used = FALSE")
                    .bind(&id)
                    .execute(pool)
                    .await?
                    .rows_affected();
            if claimed == 0 {
                tracing::warn!(user_id, "Rejected reuse of an already-consumed backup code");
                return Ok(false);
            }
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn remaining_codes(pool: &PgPool, user_id: &str) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM mfa_backup_codes WHERE user_id = $1 AND used = FALSE")
        .bind(user_id)
        .fetch_one(pool)
        .await?)
}

/// Stamp the regeneration cooldown only if it has run out; `Err(ms)` gives the wait left.
pub async fn claim_regeneration(pool: &PgPool, user_id: &str) -> anyhow::Result<Result<(), i64>> {
    let claimed = sqlx::query(
        "UPDATE users SET last_backup_code_regeneration = NOW() WHERE id = $1
           AND (last_backup_code_regeneration IS NULL OR last_backup_code_regeneration <= NOW() - make_interval(secs => $2))",
    )
    .bind(user_id)
    .bind(REGENERATION_COOLDOWN_SECS as f64)
    .execute(pool)
    .await?
    .rows_affected();
    if claimed > 0 {
        return Ok(Ok(()));
    }
    let last: Option<Option<chrono::DateTime<chrono::Utc>>> =
        sqlx::query_scalar("SELECT last_backup_code_regeneration FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let remaining = last
        .flatten()
        .map(|t| REGENERATION_COOLDOWN_SECS * 1000 - (chrono::Utc::now() - t).num_milliseconds())
        .unwrap_or(0);
    Ok(Err(remaining.max(0)))
}
