//! Sign-in sessions and the desktop/web presence heartbeats tied to them.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use sqlx::PgPool;
use tma_core::api::SessionInfo;

use crate::cache::{self, DEFAULT_TTL};
use crate::state::AppState;
use crate::util::generate_id;

/// Persisting last_activity more often than the session cache lives adds writes, not accuracy.
const ACTIVITY_WRITE_WINDOW: Duration = Duration::from_secs(300);
const MAX_SUPPRESSIONS: usize = 50_000;

fn suppressions() -> &'static DashMap<String, (Instant, Option<String>)> {
    static MAP: OnceLock<DashMap<String, (Instant, Option<String>)>> = OnceLock::new();
    MAP.get_or_init(DashMap::new)
}

pub async fn create(
    pool: &PgPool,
    user_id: &str,
    token_version: i32,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> anyhow::Result<String> {
    let id = generate_id();
    sqlx::query(
        "INSERT INTO sessions(id, user_id, token_version, user_agent, ip_address, created_at, last_activity)
         VALUES($1, $2, $3, $4, $5::inet, NOW(), NOW())",
    )
    .bind(&id)
    .bind(user_id)
    .bind(token_version)
    .bind(user_agent)
    .bind(ip)
    .execute(pool)
    .await?;
    Ok(id)
}

/// Whether a session exists and was active within the idle window. The cache
/// holds the last activity time, not a verdict, so a new idle window applies at once.
pub async fn is_valid(
    state: &AppState,
    session_id: &str,
    user_id: &str,
    token_version: i32,
    idle_secs: i64,
) -> anyhow::Result<bool> {
    let key = cache::keys::session(session_id, user_id, token_version);
    let cutoff = Utc::now().timestamp_millis() - idle_secs * 1000;
    match state.cache.get::<serde_json::Value>(&key).await {
        Some(serde_json::Value::Bool(false)) => return Ok(false),
        Some(serde_json::Value::Number(n)) if n.as_i64().is_some_and(|ms| ms > cutoff) => return Ok(true),
        _ => {}
    }
    let last: Option<i64> = sqlx::query_scalar(
        "SELECT (EXTRACT(EPOCH FROM last_activity) * 1000)::bigint FROM sessions WHERE id = $1 AND user_id = $2 AND token_version = $3",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(token_version)
    .fetch_optional(&state.pool)
    .await?;
    match last {
        Some(ms) => state.cache.fill(&key, &ms, DEFAULT_TTL).await,
        None => state.cache.fill(&key, &false, DEFAULT_TTL).await,
    }
    Ok(last.is_some_and(|ms| ms > cutoff))
}

/// Touch a session's activity, at most once per window per process (or on an IP change).
pub async fn touch(pool: &PgPool, session_id: &str, ip: Option<&str>) -> anyhow::Result<bool> {
    let map = suppressions();
    let now = Instant::now();
    if let Some(entry) = map.get(session_id)
        && entry.0 > now
        && entry.1.as_deref() == ip
    {
        return Ok(false);
    }
    if map.len() >= MAX_SUPPRESSIONS {
        map.retain(|_, v| v.0 > now);
        if map.len() >= MAX_SUPPRESSIONS {
            map.clear();
        }
    }
    map.insert(session_id.to_string(), (now + ACTIVITY_WRITE_WINDOW, ip.map(String::from)));
    let result = sqlx::query(
        "UPDATE sessions SET last_activity = NOW(), ip_address = COALESCE($2::inet, ip_address)
          WHERE id = $1 AND (last_activity < NOW() - INTERVAL '5 minutes' OR ip_address IS DISTINCT FROM $2::inet)",
    )
    .bind(session_id)
    .bind(ip)
    .execute(pool)
    .await;
    if result.is_err() {
        map.remove(session_id);
    }
    result?;
    Ok(true)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    user_id: String,
    token_version: i32,
    user_agent: Option<String>,
    ip_address: Option<String>,
    created_at: DateTime<Utc>,
    last_activity: DateTime<Utc>,
    is_online: bool,
}

/// Every live session of the current token version, newest activity first.
pub async fn active(pool: &PgPool, user_id: &str, token_version: i32) -> anyhow::Result<Vec<SessionInfo>> {
    let rows = sqlx::query_as::<_, SessionRow>(
        "SELECT s.id, s.user_id, s.token_version, s.user_agent,
                COALESCE(online_client.ip_address, host(s.ip_address)) AS ip_address,
                s.created_at, s.last_activity, (online_client.last_seen_at IS NOT NULL) AS is_online
           FROM sessions s
           LEFT JOIN LATERAL (
             SELECT h.ip_address, h.last_seen_at FROM client_heartbeats h
              WHERE h.user_id = s.user_id AND h.session_id = s.id AND h.last_seen_at > NOW() - INTERVAL '3 minutes'
              ORDER BY h.last_seen_at DESC LIMIT 1
           ) online_client ON TRUE
          WHERE s.user_id = $1 AND s.token_version = $2
          ORDER BY s.last_activity DESC",
    )
    .bind(user_id)
    .bind(token_version)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| SessionInfo {
            id: r.id,
            user_id: r.user_id,
            token_version: r.token_version,
            user_agent: r.user_agent,
            ip_address: r.ip_address,
            created_at: r.created_at,
            last_activity: r.last_activity,
            is_online: r.is_online,
            is_current: false,
        })
        .collect())
}

pub async fn delete(state: &AppState, session_id: &str, user_id: &str) -> anyhow::Result<bool> {
    let version: Option<i32> =
        sqlx::query_scalar("DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_version")
            .bind(session_id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some(v) = version {
        state.cache.invalidate(&[cache::keys::session(session_id, user_id, v)]).await;
    }
    Ok(version.is_some())
}

pub async fn delete_others(state: &AppState, user_id: &str, keep: &str, token_version: i32) -> anyhow::Result<i64> {
    let deleted: Vec<(String, i32)> = sqlx::query_as(
        "DELETE FROM sessions WHERE user_id = $1 AND token_version = $2 AND id != $3 RETURNING id, token_version",
    )
    .bind(user_id)
    .bind(token_version)
    .bind(keep)
    .fetch_all(&state.pool)
    .await?;
    forget(state, user_id, &deleted).await;
    Ok(deleted.len() as i64)
}

pub async fn delete_all(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    let deleted: Vec<(String, i32)> =
        sqlx::query_as("DELETE FROM sessions WHERE user_id = $1 RETURNING id, token_version")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    forget(state, user_id, &deleted).await;
    Ok(())
}

/// Invalidate the cached verdicts of deleted `(id, token_version)` sessions.
async fn forget(state: &AppState, user_id: &str, deleted: &[(String, i32)]) {
    let keys: Vec<String> = deleted.iter().map(|(id, v)| cache::keys::session(id, user_id, *v)).collect();
    state.cache.invalidate(&keys).await;
}

/// Whether the user signed in within `max_age_secs` (re-authentication gate).
pub async fn is_recent(pool: &PgPool, session_id: &str, user_id: &str, max_age_secs: i64) -> anyhow::Result<bool> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND created_at > NOW() - make_interval(secs => $3)",
    )
    .bind(session_id)
    .bind(user_id)
    .bind(max_age_secs as f64)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

/// Delete sessions that can no longer authenticate: idle past the timeout, or
/// from before a "log out everywhere".
pub async fn cleanup_old(pool: &PgPool) -> anyhow::Result<u64> {
    let mut total = 0;
    for _ in 0..20 {
        let deleted = sqlx::query(
            "WITH doomed AS (
               SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.last_activity < NOW() - INTERVAL '1 day' * (SELECT session_idle_days FROM app_settings WHERE id = 'app_settings')
                   OR s.token_version <> u.token_version
                LIMIT 5000
             )
             DELETE FROM sessions s USING doomed WHERE s.id = doomed.id",
        )
        .execute(pool)
        .await?
        .rows_affected();
        total += deleted;
        if deleted < 5000 {
            break;
        }
    }
    if total > 0 {
        tracing::info!(deleted = total, "Cleaned up expired sessions");
    }
    Ok(total)
}

/// Upsert a presence heartbeat; one row per desktop install, or per session for the web.
/// One presence report: who, from which install or session, on what version.
pub struct Heartbeat<'a> {
    pub client_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub app_version: &'a str,
    pub platform: Option<&'a str>,
    pub user_agent: Option<&'a str>,
    pub ip: Option<&'a str>,
}

pub async fn heartbeat(pool: &PgPool, user_id: &str, beat: &Heartbeat<'_>) -> anyhow::Result<()> {
    let Heartbeat { client_id, session_id, app_version, platform, user_agent, ip } = *beat;
    let unique = client_id.or(session_id).unwrap_or("no-session");
    sqlx::query(
        "INSERT INTO client_heartbeats (id, user_id, session_id, app_version, platform, user_agent, ip_address, last_seen_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET session_id = EXCLUDED.session_id, app_version = EXCLUDED.app_version,
           platform = EXCLUDED.platform, user_agent = EXCLUDED.user_agent, ip_address = EXCLUDED.ip_address, last_seen_at = NOW()",
    )
    .bind(format!("{user_id}:{unique}"))
    .bind(user_id)
    .bind(session_id)
    .bind(app_version)
    .bind(platform)
    .bind(user_agent)
    .bind(ip)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_heartbeat(pool: &PgPool, user_id: &str, session_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM client_heartbeats WHERE user_id = $1 AND session_id = $2")
        .bind(user_id)
        .bind(session_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_all_heartbeats(pool: &PgPool, user_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM client_heartbeats WHERE user_id = $1").bind(user_id).execute(pool).await?;
    Ok(())
}

pub async fn delete_other_heartbeats(pool: &PgPool, user_id: &str, keep_session: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM client_heartbeats WHERE user_id = $1 AND (session_id IS NULL OR session_id != $2)")
        .bind(user_id)
        .bind(keep_session)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn purge_stale_heartbeats(pool: &PgPool, older_than_minutes: i64) -> anyhow::Result<u64> {
    let deleted = sqlx::query("DELETE FROM client_heartbeats WHERE last_seen_at < NOW() - INTERVAL '1 minute' * $1")
        .bind(older_than_minutes as f64)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(deleted)
}
