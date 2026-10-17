//! Writes to `app_settings`. Each runs in a transaction that first proves the
//! caller is the first user, so the rule holds even if two requests race.

use sqlx::{PgPool, Postgres, Transaction};

use crate::error::DomainError;

/// Prove `user_id` is the first user inside `tx`, recording it if not yet stored.
pub async fn verify_first_user(tx: &mut Transaction<'_, Postgres>, user_id: &str, action: &str) -> anyhow::Result<()> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT first_user_id FROM app_settings WHERE id = 'app_settings'")
            .fetch_optional(&mut **tx)
            .await?;
    let Some(stored) = stored else { anyhow::bail!("App settings not found") };
    match stored {
        Some(first) if first == user_id => Ok(()),
        Some(_) => Err(DomainError::Forbidden(format!("Only the first user can {action}")).into()),
        None => {
            let first: Option<String> =
                sqlx::query_scalar("SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE")
                    .fetch_optional(&mut **tx)
                    .await?;
            match first {
                Some(first) if first == user_id => {
                    sqlx::query("UPDATE app_settings SET first_user_id = $1 WHERE id = 'app_settings' AND first_user_id IS NULL")
                        .bind(&first)
                        .execute(&mut **tx)
                        .await?;
                    Ok(())
                }
                Some(_) => Err(DomainError::Forbidden(format!("Only the first user can {action}")).into()),
                None => anyhow::bail!("No users exist"),
            }
        }
    }
}

/// A boolean column of `app_settings`, written by the first user.
#[derive(Debug, Clone, Copy)]
pub enum FlagSetting {
    SignupEnabled,
    HideFileExtensions,
    DesktopOnly,
    AllowPasswordChange,
    CloudDriveSaveOnly,
}

impl FlagSetting {
    fn column(self) -> &'static str {
        match self {
            Self::SignupEnabled => "signup_enabled",
            Self::HideFileExtensions => "hide_file_extensions",
            Self::DesktopOnly => "desktop_only",
            Self::AllowPasswordChange => "allow_password_change",
            Self::CloudDriveSaveOnly => "cloud_drive_save_only",
        }
    }

    pub fn action(self) -> &'static str {
        match self {
            Self::SignupEnabled => "toggle signup",
            Self::HideFileExtensions => "configure hide file extensions",
            Self::DesktopOnly => "configure desktop-only access",
            Self::AllowPasswordChange => "configure password change",
            Self::CloudDriveSaveOnly => "configure the Cloud Drive mode",
        }
    }
}

pub async fn set_flag(pool: &PgPool, user_id: &str, setting: FlagSetting, value: bool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, setting.action()).await?;
    let sql =
        format!("UPDATE app_settings SET {} = $1, updated_at = NOW() WHERE id = 'app_settings'", setting.column());
    sqlx::query(sqlx::AssertSqlSafe(sql)).bind(value).execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!(user_id, setting = setting.column(), value, "[SECURITY] Setting updated by first user");
    Ok(())
}

pub async fn set_onlyoffice(
    pool: &PgPool,
    user_id: &str,
    secret: Option<String>,
    url: Option<String>,
) -> anyhow::Result<()> {
    if secret.is_some() != url.is_some() {
        return Err(DomainError::BadRequest(
            "Both URL and JWT Secret must be provided together, or both must be empty".into(),
        )
        .into());
    }
    if secret.as_deref().is_some_and(|s| s.trim().is_empty()) {
        return Err(DomainError::BadRequest("JWT secret must be a non-empty string or null".into()).into());
    }
    let url = match url {
        Some(u) => Some(super::normalize_onlyoffice_url(&u).map_err(DomainError::BadRequest)?),
        None => None,
    };
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure OnlyOffice").await?;
    sqlx::query("UPDATE app_settings SET onlyoffice_jwt_secret = $1, onlyoffice_url = $2, updated_at = NOW() WHERE id = 'app_settings'")
        .bind(secret)
        .bind(url)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(user_id, "[SECURITY] OnlyOffice settings updated by first user");
    Ok(())
}

pub async fn set_share_base_url(pool: &PgPool, user_id: &str, url: Option<String>) -> anyhow::Result<()> {
    let url = match url.map(|u| u.trim().to_string()) {
        Some(u) if u.is_empty() => {
            return Err(DomainError::BadRequest("Share base URL must be a non-empty string or null".into()).into());
        }
        Some(u) => {
            url::Url::parse(&u).map_err(|_| DomainError::BadRequest("Invalid URL format".into()))?;
            Some(u)
        }
        None => None,
    };
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure share base URL").await?;
    sqlx::query("UPDATE app_settings SET share_base_url = $1, updated_at = NOW() WHERE id = 'app_settings'")
        .bind(url)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn set_max_upload(pool: &PgPool, user_id: &str, max_bytes: i64) -> anyhow::Result<()> {
    if !(super::MIN_MAX_UPLOAD_BYTES..=super::MAX_MAX_UPLOAD_BYTES).contains(&max_bytes) {
        return Err(DomainError::BadRequest(format!(
            "Max upload size must be between {} and {} bytes",
            super::MIN_MAX_UPLOAD_BYTES,
            super::MAX_MAX_UPLOAD_BYTES
        ))
        .into());
    }
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure max upload size").await?;
    sqlx::query("UPDATE app_settings SET max_upload_size_bytes = $1, updated_at = NOW() WHERE id = 'app_settings'")
        .bind(max_bytes)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn set_known_proxies(pool: &PgPool, user_id: &str, proxies: &[String]) -> anyhow::Result<Vec<String>> {
    let normalized = super::normalize_known_proxies(proxies).map_err(DomainError::BadRequest)?;
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure known proxies").await?;
    sqlx::query("UPDATE app_settings SET known_proxies = $1, updated_at = NOW() WHERE id = 'app_settings'")
        .bind(&normalized)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(user_id, count = normalized.len(), "[SECURITY] Known proxies settings updated");
    Ok(normalized)
}

pub async fn set_idle_days(pool: &PgPool, user_id: &str, days: i64) -> anyhow::Result<()> {
    let days = super::normalize_idle_days(days).map_err(DomainError::BadRequest)?;
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure the session timeout").await?;
    sqlx::query("UPDATE app_settings SET session_idle_days = $1, updated_at = NOW() WHERE id = 'app_settings'")
        .bind(days)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn set_access_time(
    pool: &PgPool,
    user_id: &str,
    enabled: bool,
    window: i64,
    flush: i64,
) -> anyhow::Result<()> {
    let (enabled, window, flush) =
        super::normalize_access_time(enabled, window, flush).map_err(DomainError::BadRequest)?;
    let mut tx = pool.begin().await?;
    verify_first_user(&mut tx, user_id, "configure access time tracking").await?;
    sqlx::query(
        "UPDATE app_settings SET access_time_tracking = $1, access_time_window_minutes = $2,
                access_time_flush_seconds = $3, updated_at = NOW() WHERE id = 'app_settings'",
    )
    .bind(enabled)
    .bind(window)
    .bind(flush)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
