//! Bucket settings: validation of what the first user enters, and the
//! encrypted copy kept in `app_settings`. The secret key never leaves memory.

use std::net::IpAddr;

use sqlx::PgPool;
use tma_core::api::{StorageSettingsInput, StorageSettingsSummary};

use crate::crypto::{Keyring, STORAGE_SECRET, open_secret, seal_secret};
use crate::error::DomainError;

const DEFAULT_REGION: &str = "us-east-1";

/// A complete, validated configuration including the secret.
#[derive(Clone, PartialEq, Eq)]
pub struct StorageConfig {
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub force_path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub version: i32,
}

impl std::fmt::Debug for StorageConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StorageConfig").field("endpoint", &self.endpoint).field("bucket", &self.bucket).finish()
    }
}

fn bad(message: impl Into<String>) -> DomainError {
    DomainError::BadRequest(message.into())
}

fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || v4.is_loopback() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn is_forbidden(ip: IpAddr) -> bool {
    match ip {
        // Link-local holds cloud instance metadata (169.254.169.254).
        IpAddr::V4(v4) => v4.is_link_local() || v4.octets()[0] == 0,
        IpAddr::V6(v6) => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

fn is_internal_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return is_private(ip);
    }
    host == "localhost"
        || !host.contains('.')
        || [".local", ".internal", ".lan", ".home.arpa", ".localhost"].iter().any(|s| host.ends_with(s))
}

/// Reduce an endpoint to its origin; credentials, paths and queries are refused.
pub fn normalize_endpoint(raw: &str) -> Result<String, DomainError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(bad("Endpoint URL is required"));
    }
    if raw.len() > 2048 {
        return Err(bad("Endpoint URL is too long"));
    }
    let url = url::Url::parse(raw).map_err(|_| bad("Endpoint must be a valid URL, such as https://s3.example.com"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(bad("Endpoint must use https:// or http://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("Endpoint must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("Endpoint must not contain a query string or fragment"));
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err(bad("Endpoint must not contain a path; set the bucket separately"));
    }
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok_and(is_forbidden) {
        return Err(bad("Endpoint points at a reserved address"));
    }
    if url.scheme() == "http" && !is_internal_host(&host) {
        return Err(bad(
            "Plain http:// is only allowed for private network addresses; use https:// for public endpoints",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn normalize_bucket(raw: Option<&str>) -> Result<String, DomainError> {
    let bucket = raw.unwrap_or("").trim();
    if bucket.is_empty() {
        return Err(bad("Bucket name is required"));
    }
    let shape = bucket.len() >= 3
        && bucket.len() <= 63
        && bucket.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        && bucket.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && bucket.chars().last().is_some_and(|c| c.is_ascii_alphanumeric());
    if !shape
        || bucket.contains("..")
        || bucket.parse::<IpAddr>().is_ok()
        || bucket.starts_with("xn--")
        || bucket.ends_with("-s3alias")
    {
        return Err(bad(
            "Bucket name must be 3-63 lowercase letters, numbers, dots or hyphens, starting and ending alphanumerically",
        ));
    }
    Ok(bucket.to_string())
}

fn normalize_credential(raw: Option<&str>, label: &str, max: usize) -> Result<String, DomainError> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty() {
        return Err(bad(format!("{label} is required")));
    }
    if value.len() > max || !value.chars().all(|c| ('\x21'..='\x7e').contains(&c)) {
        return Err(bad(format!("{label} is not valid")));
    }
    Ok(value.to_string())
}

fn normalize_region(raw: Option<&str>, provider: &str) -> Result<String, DomainError> {
    let region = raw.unwrap_or("").trim().to_ascii_lowercase();
    match provider {
        "r2" => Ok("auto".into()),
        "aws" => {
            let parts: Vec<&str> = region.split('-').collect();
            let ok = parts.len() >= 3
                && parts[0].len() == 2
                && parts[0].chars().all(|c| c.is_ascii_lowercase())
                && parts.last().is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
                && parts[1..parts.len() - 1]
                    .iter()
                    .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()));
            if ok { Ok(region) } else { Err(bad("AWS region is required, such as eu-west-1")) }
        }
        _ if region.is_empty() => Ok(DEFAULT_REGION.into()),
        _ => {
            let ok = region.len() <= 63
                && region.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
                && region.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if ok { Ok(region) } else { Err(bad("Region may only contain lowercase letters, numbers and hyphens")) }
        }
    }
}

/// Turn admin input into the stored shape, reusing saved credentials left blank.
pub fn normalize_settings(
    input: &StorageSettingsInput,
    current: Option<&StorageConfig>,
) -> Result<StorageConfig, DomainError> {
    let provider = input.provider.as_str();
    if !matches!(provider, "s3" | "r2" | "aws") {
        return Err(bad("Provider must be one of: s3, r2, aws"));
    }
    let region = normalize_region(input.region.as_deref(), provider)?;
    let raw_endpoint = input.endpoint.as_deref().unwrap_or("").trim();
    let endpoint = if provider == "aws" && raw_endpoint.is_empty() {
        format!("https://s3.{region}.amazonaws.com")
    } else {
        normalize_endpoint(raw_endpoint)?
    };
    let force_path_style = if provider == "s3" { input.force_path_style.unwrap_or(true) } else { false };
    let blank = |v: &Option<String>| v.as_deref().is_none_or(|s| s.trim().is_empty());
    let (access_key_id, secret_access_key) = match current {
        Some(cur) if blank(&input.access_key_id) && blank(&input.secret_access_key) => {
            (cur.access_key_id.clone(), cur.secret_access_key.clone())
        }
        _ => {
            let key = normalize_credential(input.access_key_id.as_deref(), "Access key ID", 128)?;
            if blank(&input.secret_access_key) {
                match current {
                    Some(cur) if cur.access_key_id == key => (key, cur.secret_access_key.clone()),
                    _ => return Err(bad("Secret access key is required")),
                }
            } else {
                (key, normalize_credential(input.secret_access_key.as_deref(), "Secret access key", 256)?)
            }
        }
    };
    Ok(StorageConfig {
        provider: provider.into(),
        endpoint,
        region,
        bucket: normalize_bucket(input.bucket.as_deref())?,
        force_path_style,
        access_key_id,
        secret_access_key,
        version: 0,
    })
}

pub fn mask_access_key(id: &str) -> String {
    if id.len() <= 8 { "••••".into() } else { format!("{}••••{}", &id[..4], &id[id.len() - 4..]) }
}

#[derive(sqlx::FromRow)]
struct StorageRow {
    storage_provider: Option<String>,
    storage_endpoint: Option<String>,
    storage_region: Option<String>,
    storage_bucket: Option<String>,
    storage_force_path_style: Option<bool>,
    storage_access_key_id: Option<String>,
    storage_secret_encrypted: Option<Vec<u8>>,
    storage_secret_kek_version: Option<i32>,
    storage_updated_at: Option<chrono::DateTime<chrono::Utc>>,
    storage_config_version: i32,
}

const STORAGE_COLUMNS: &str = "storage_provider, storage_endpoint, storage_region, storage_bucket, storage_force_path_style,
  storage_access_key_id, storage_secret_encrypted, storage_secret_kek_version, storage_updated_at, storage_config_version";

async fn read_row<'e, E: sqlx::PgExecutor<'e>>(db: E, for_update: bool) -> anyhow::Result<Option<StorageRow>> {
    let sql = format!(
        "SELECT {STORAGE_COLUMNS} FROM app_settings WHERE id = 'app_settings'{}",
        if for_update { " FOR UPDATE" } else { "" }
    );
    Ok(sqlx::query_as::<_, StorageRow>(sqlx::AssertSqlSafe(sql)).fetch_optional(db).await?)
}

/// The active configuration with the secret decrypted, or `None` before setup.
pub async fn load(pool: &PgPool, keyring: &Keyring) -> anyhow::Result<Option<StorageConfig>> {
    let Some(row) = read_row(pool, false).await? else { return Ok(None) };
    let (Some(provider), Some(akid), Some(sealed), Some(kv)) =
        (row.storage_provider, row.storage_access_key_id, row.storage_secret_encrypted, row.storage_secret_kek_version)
    else {
        return Ok(None);
    };
    let secret = open_secret(&sealed, &STORAGE_SECRET, &akid, keyring.kek(kv)?)?;
    Ok(Some(StorageConfig {
        provider,
        endpoint: row.storage_endpoint.unwrap_or_default(),
        region: row.storage_region.unwrap_or_else(|| DEFAULT_REGION.into()),
        bucket: row.storage_bucket.unwrap_or_default(),
        force_path_style: row.storage_force_path_style.unwrap_or(true),
        access_key_id: akid,
        secret_access_key: secret,
        version: row.storage_config_version,
    }))
}

/// What the admin UI may see: everything except the secret, with the key ID masked.
pub async fn summary(pool: &PgPool) -> anyhow::Result<StorageSettingsSummary> {
    let row = read_row(pool, false).await?;
    let version = row.as_ref().map(|r| r.storage_config_version).unwrap_or(0);
    let Some(row) = row.filter(|r| r.storage_provider.is_some()) else {
        return Ok(StorageSettingsSummary { configured: false, version, ..Default::default() });
    };
    Ok(StorageSettingsSummary {
        configured: true,
        version,
        provider: row.storage_provider,
        endpoint: row.storage_endpoint,
        region: row.storage_region,
        bucket: row.storage_bucket,
        force_path_style: row.storage_force_path_style,
        access_key_id_masked: row.storage_access_key_id.as_deref().map(mask_access_key),
        updated_at: row.storage_updated_at,
    })
}

/// Persist a verified configuration as a compare-and-swap on the config version.
pub async fn save(
    pool: &PgPool,
    keyring: &Keyring,
    config: &StorageConfig,
    user_id: &str,
    expected: Option<i32>,
) -> anyhow::Result<i32> {
    let mut tx = pool.begin().await?;
    crate::settings::verify_first_user(&mut tx, user_id, "configure storage").await?;
    let current = read_row(&mut *tx, true).await?;
    if let (Some(expected), Some(current)) = (expected, current.as_ref())
        && current.storage_config_version != expected
    {
        return Err(DomainError::Conflict(
            "Storage settings were changed by another session. Reload and try again.".into(),
        )
        .into());
    }
    let kv = keyring.primary_version();
    let sealed =
        seal_secret(&config.secret_access_key, &STORAGE_SECRET, &config.access_key_id, keyring.primary_kek()?)?;
    let version: i32 = sqlx::query_scalar(
        "UPDATE app_settings SET storage_provider = $1, storage_endpoint = $2, storage_region = $3, storage_bucket = $4,
           storage_force_path_style = $5, storage_access_key_id = $6, storage_secret_encrypted = $7,
           storage_secret_kek_version = $8, storage_updated_at = NOW(),
           storage_config_version = storage_config_version + 1, updated_at = NOW()
         WHERE id = 'app_settings' RETURNING storage_config_version",
    )
    .bind(&config.provider)
    .bind(&config.endpoint)
    .bind(&config.region)
    .bind(&config.bucket)
    .bind(config.force_path_style)
    .bind(&config.access_key_id)
    .bind(sealed)
    .bind(kv)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(user_id, version, "[SECURITY] Storage settings updated by first user");
    Ok(version)
}

/// Recent object keys, used to prove a new target still holds the existing files.
pub async fn sample_keys(pool: &PgPool, limit: i64) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT path FROM files WHERE type = 'file' AND path IS NOT NULL ORDER BY created_at DESC NULLS LAST LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

/// Rewrap the stored secret under the primary KEK after a key rotation.
pub async fn rewrap_secret(pool: &PgPool, keyring: &Keyring) -> anyhow::Result<bool> {
    let mut tx = pool.begin().await?;
    let Some(row) = read_row(&mut *tx, true).await? else { return Ok(false) };
    let (Some(akid), Some(sealed), Some(kv)) =
        (row.storage_access_key_id, row.storage_secret_encrypted, row.storage_secret_kek_version)
    else {
        return Ok(false);
    };
    if kv == keyring.primary_version() {
        return Ok(false);
    }
    let secret = open_secret(&sealed, &STORAGE_SECRET, &akid, keyring.kek(kv)?)?;
    let resealed = seal_secret(&secret, &STORAGE_SECRET, &akid, keyring.primary_kek()?)?;
    sqlx::query("UPDATE app_settings SET storage_secret_encrypted = $1, storage_secret_kek_version = $2 WHERE id = 'app_settings'")
        .bind(resealed)
        .bind(keyring.primary_version())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        assert_eq!(normalize_endpoint("https://s3.example.com/").ok().as_deref(), Some("https://s3.example.com"));
        assert_eq!(normalize_endpoint("http://10.1.2.103:9001").ok().as_deref(), Some("http://10.1.2.103:9001"));
        assert!(normalize_endpoint("http://s3.example.com").is_err());
        assert!(normalize_endpoint("http://169.254.169.254").is_err());
        assert!(normalize_endpoint("https://s3.example.com/bucket").is_err());
    }

    #[test]
    fn blank_credentials_keep_saved_pair() {
        let current = StorageConfig {
            provider: "s3".into(),
            endpoint: "http://10.0.0.5:9000".into(),
            region: "us-east-1".into(),
            bucket: "tma".into(),
            force_path_style: true,
            access_key_id: "AKIDEXAMPLE".into(),
            secret_access_key: "secret".into(),
            version: 3,
        };
        let input = StorageSettingsInput {
            provider: "s3".into(),
            endpoint: Some("http://10.0.0.5:9000".into()),
            bucket: Some("tma".into()),
            ..Default::default()
        };
        let next = normalize_settings(&input, Some(&current)).unwrap();
        assert_eq!(next.secret_access_key, "secret");
        assert_eq!(mask_access_key("AKIDEXAMPLE"), "AKID••••MPLE");
    }
}
