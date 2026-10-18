//! Master key safety: refuse to start with a key that does not match the data,
//! and rewrap stored keys to the newest master key after a rotation.

use anyhow::{Result, bail};
use sqlx::PgPool;

use crate::crypto::{Keyring, STORAGE_SECRET, kek_check_matches, kek_check_value, open_secret, unwrap_dek};

/// Every version that file keys or settings secrets are wrapped under.
async fn versions_in_use(pool: &PgPool) -> Result<Vec<i32>> {
    let rows: Vec<Option<i32>> = sqlx::query_scalar(
        "SELECT DISTINCT dek_kek_version FROM files WHERE dek_wrapped IS NOT NULL
         UNION SELECT storage_secret_kek_version FROM app_settings WHERE id = 'app_settings' AND storage_secret_encrypted IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().flatten().collect())
}

/// Before a version has a stored check value, prove the key against data already sealed with it.
async fn opens_existing_data(pool: &PgPool, version: i32, kek: &[u8; 32]) -> Result<bool> {
    let dek: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT dek_wrapped FROM files WHERE dek_kek_version = $1 AND dek_wrapped IS NOT NULL LIMIT 1",
    )
    .bind(version)
    .fetch_optional(pool)
    .await?;
    if let Some(dek) = dek
        && unwrap_dek(&dek, kek).is_err()
    {
        return Ok(false);
    }
    let storage: Option<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT storage_secret_encrypted, storage_access_key_id FROM app_settings WHERE id = 'app_settings' AND storage_secret_kek_version = $1",
    )
    .bind(version)
    .fetch_optional(pool)
    .await?;
    if let Some((sealed, akid)) = storage
        && open_secret(&sealed, &STORAGE_SECRET, &akid, kek).is_err()
    {
        return Ok(false);
    }
    Ok(true)
}

/// Check every configured key against its stored check value (recording one the
/// first time a version is seen), and that no stored data needs a missing version.
pub async fn verify(pool: &PgPool, keyring: &Keyring) -> Result<()> {
    let configured = keyring.versions();
    let missing: Vec<i32> = versions_in_use(pool).await?.into_iter().filter(|v| !configured.contains(v)).collect();
    if !missing.is_empty() {
        let list: Vec<String> = missing.iter().map(|v| v.to_string()).collect();
        bail!(
            "Stored data is encrypted under key version {}, which FILE_ENCRYPTION_KEY does not contain. Restore the key file that has every version.",
            list.join(", ")
        );
    }
    let checks: Vec<(i32, Vec<u8>)> =
        sqlx::query_as("SELECT version, check_value FROM kek_checks").fetch_all(pool).await?;
    let mismatch = |v: i32| {
        anyhow::anyhow!(
            "FILE_ENCRYPTION_KEY (key version {v}) does not match the key this deployment's data was encrypted with. Restore the original key file or value."
        )
    };
    for version in configured {
        let kek = keyring.kek(version)?;
        if let Some((_, stored)) = checks.iter().find(|(v, _)| *v == version) {
            if !kek_check_matches(kek, stored) {
                return Err(mismatch(version));
            }
            continue;
        }
        if !opens_existing_data(pool, version, kek).await? {
            return Err(mismatch(version));
        }
        sqlx::query("INSERT INTO kek_checks (version, check_value) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING")
            .bind(version)
            .bind(kek_check_value(kek))
            .execute(pool)
            .await?;
        // Another process may have recorded first; whichever value won must still match.
        let recorded: Vec<u8> = sqlx::query_scalar("SELECT check_value FROM kek_checks WHERE version = $1")
            .bind(version)
            .fetch_one(pool)
            .await?;
        if !kek_check_matches(kek, &recorded) {
            return Err(mismatch(version));
        }
        tracing::info!(version, "[Encryption] Recorded key check value for master key version");
    }
    Ok(())
}

/// Outcome of a rewrap run.
#[derive(Debug, Default)]
pub struct RewrapReport {
    pub primary: i32,
    pub storage_secret: bool,
    pub rewrapped: u64,
    pub failures: Vec<(String, i32, String)>,
}

/// Rewrap every data key not under the primary KEK. Only ~60-byte wrapped keys
/// change; file bodies are never read. Safe to interrupt and to run twice at once.
pub async fn rewrap_to_primary(pool: &PgPool, keyring: &Keyring) -> Result<RewrapReport> {
    let primary = keyring.primary_version();
    let mut report = RewrapReport {
        primary,
        storage_secret: crate::storage::config::rewrap_secret(pool, keyring).await?,
        ..Default::default()
    };
    // The cursor passes failing rows too, so one bad row cannot stall the run.
    let mut cursor = String::new();
    loop {
        let rows: Vec<(String, Vec<u8>, i32)> = sqlx::query_as(
            "SELECT id, dek_wrapped, dek_kek_version FROM files
              WHERE dek_wrapped IS NOT NULL AND dek_kek_version IS DISTINCT FROM $1 AND id > $2 ORDER BY id LIMIT 500",
        )
        .bind(primary)
        .bind(&cursor)
        .fetch_all(pool)
        .await?;
        let Some(last) = rows.last() else { break };
        cursor = last.0.clone();
        let (mut ids, mut wrapped, mut from) = (Vec::new(), Vec::new(), Vec::new());
        for (id, dek, version) in rows {
            match keyring.rewrap_to_primary(&dek, version) {
                Ok(Some((next, _))) => {
                    ids.push(id);
                    wrapped.push(next);
                    from.push(version);
                }
                Ok(None) => {}
                Err(err) => report.failures.push((id, version, err.to_string())),
            }
        }
        if !ids.is_empty() {
            report.rewrapped += sqlx::query(
                "UPDATE files AS f SET dek_wrapped = v.dw, dek_kek_version = $4
                   FROM unnest($1::text[], $2::bytea[], $3::int[]) AS v(id, dw, old)
                  WHERE f.id = v.id AND f.dek_kek_version = v.old",
            )
            .bind(&ids)
            .bind(&wrapped)
            .bind(&from)
            .bind(primary)
            .execute(pool)
            .await?
            .rows_affected();
        }
    }
    Ok(report)
}
