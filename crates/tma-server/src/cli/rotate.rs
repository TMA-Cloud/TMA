//! Master key rotation and the database password, as `rotate.sh` drives them.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;

use anyhow::{Context, bail};

use super::{RotateAction, env_path, set_env_value, write_atomic};
use crate::config::{Config, read_secret};
use crate::crypto::{Keyring, format_keyring, generate_key};
use crate::{db, services};

const BACKUP_GUIDE: &str = "https://tma-cloud.github.io/Wiki/docs/guides/operations/backups";

pub async fn run(action: RotateAction) -> anyhow::Result<()> {
    let config = Config::from_env()?;
    if let RotateAction::DbPassword { stdin } = action {
        return db_password(&config, stdin).await;
    }
    let allow_passphrase = matches!(action, RotateAction::Key);
    let keyring = Keyring::from_env(config.production, allow_passphrase)?;
    let pool = db::connect(&config.database_url, 2).await?;
    db::run_migrations(&pool).await?;
    services::keys::verify(&pool, &keyring).await?;
    match action {
        RotateAction::Status => status(&pool, &keyring).await,
        RotateAction::Key => add_key(&pool, &keyring).await,
        RotateAction::Rewrap => rewrap(&pool, &keyring).await,
        RotateAction::DbPassword { .. } => Ok(()),
    }
}

async fn file_key_versions(pool: &sqlx::PgPool) -> anyhow::Result<Vec<(i32, i64)>> {
    Ok(sqlx::query_as(
        "SELECT dek_kek_version, COUNT(*) FROM files WHERE dek_kek_version IS NOT NULL GROUP BY 1 ORDER BY 1",
    )
    .fetch_all(pool)
    .await?)
}

async fn status(pool: &sqlx::PgPool, keyring: &Keyring) -> anyhow::Result<()> {
    let primary = keyring.primary_version();
    let files = file_key_versions(pool).await?;
    let (storage, google): (Option<i32>, Option<i32>) =
        sqlx::query_as("SELECT storage_secret_kek_version, google_client_secret_kek_version FROM app_settings WHERE id = 'app_settings'")
            .fetch_optional(pool)
            .await?
            .unwrap_or((None, None));
    let versions: Vec<String> = keyring.versions().iter().map(|v| v.to_string()).collect();
    println!("Master key versions: {}", versions.join(", "));
    println!("Newest (encrypts new files): {primary}");
    for (version, count) in &files {
        println!("  version {version}: {count} file key(s)");
    }
    if let Some(v) = storage {
        println!("Bucket secret: version {v}");
    }
    if let Some(v) = google {
        println!("Google client secret: version {v}");
    }
    let behind: i64 = files.iter().filter(|(v, _)| *v != primary).map(|(_, n)| n).sum();
    if behind > 0 {
        println!("{behind} file key(s) still use an older version. The worker rewraps them when it starts.");
    } else {
        println!("All keys are current.");
    }
    let unused: Vec<String> = keyring
        .versions()
        .into_iter()
        .filter(|v| *v != primary && !files.iter().any(|(f, _)| f == v) && Some(*v) != storage && Some(*v) != google)
        .map(|v| v.to_string())
        .collect();
    if !unused.is_empty() {
        println!(
            "Not used by current data: version {}. Database backups from before a rotation still need them, so remove a line only once you no longer keep those backups.",
            unused.join(", ")
        );
    }
    Ok(())
}

async fn add_key(pool: &sqlx::PgPool, keyring: &Keyring) -> anyhow::Result<()> {
    let text = read_secret("FILE_ENCRYPTION_KEY")?
        .context("FILE_ENCRYPTION_KEY is not set. Generate one with \"tma-server key generate\".")?;
    let mut keys: BTreeMap<u32, String> = crate::crypto::parse_keyring(&text)?;
    let recorded: Option<i32> = sqlx::query_scalar("SELECT MAX(version) FROM kek_checks").fetch_one(pool).await?;
    let version = keyring.primary_version().max(recorded.unwrap_or(0)) + 1;
    keys.insert(version as u32, generate_key());
    if let Ok(file) = std::env::var("FILE_ENCRYPTION_KEY_FILE").map(PathBuf::from) {
        write_atomic(&file, &format_keyring(&keys))?;
        println!("Added key version {version} to {}.", file.display());
    } else {
        let Some(path) = env_path() else {
            bail!("FILE_ENCRYPTION_KEY is not set in a .env file. Add the new key where it is defined.")
        };
        let env = std::fs::read_to_string(&path)?;
        let value: Vec<String> = keys.iter().map(|(v, k)| format!("{v}:{k}")).collect();
        let Some(updated) = set_env_value(&env, "FILE_ENCRYPTION_KEY", &value.join(",")) else {
            bail!("FILE_ENCRYPTION_KEY is not set in {}. Add the new key where it is defined.", path.display());
        };
        write_atomic(&path, &updated)?;
        println!("Added key version {version} to FILE_ENCRYPTION_KEY in {}.", path.display());
    }
    println!("Next:");
    println!("  1. Restart the server, then the worker. The worker rewraps stored file keys when it starts.");
    println!("  2. Check progress: tma-server rotate status");
    println!("  3. Back up the key again: {BACKUP_GUIDE}");
    Ok(())
}

async fn rewrap(pool: &sqlx::PgPool, keyring: &Keyring) -> anyhow::Result<()> {
    let report = services::keys::rewrap_to_primary(pool, keyring).await?;
    if report.storage_secret {
        println!("Bucket secret rewrapped to version {}.", report.primary);
    }
    if report.google_secret {
        println!("Google client secret rewrapped to version {}.", report.primary);
    }
    let files = file_key_versions(pool).await?;
    let current = files.iter().find(|(v, _)| *v == report.primary).map(|r| r.1).unwrap_or(0);
    let older: i64 = files.iter().map(|r| r.1).sum::<i64>() - current;
    println!(
        "This run rewrapped {}. {current} file key(s) use version {}, {older} an older one.",
        report.rewrapped, report.primary
    );
    if !report.failures.is_empty() {
        for (id, from, error) in report.failures.iter().take(20) {
            eprintln!("  {id} (version {from}): {error}");
        }
        bail!("{} file key(s) could not be rewrapped", report.failures.len());
    }
    Ok(())
}

const MIN_DB_PASSWORD_LENGTH: usize = 16;

/// A SCRAM-SHA-256 verifier, so the new password never reaches the server in plain text.
fn scram_verifier(password: &str) -> String {
    use base64::Engine as _;
    use ring::{digest, hmac, pbkdf2};
    const ITERATIONS: u32 = 4096;
    let salt: [u8; 16] = crate::crypto::random_bytes();
    let mut salted = [0u8; 32];
    let iterations = std::num::NonZeroU32::new(ITERATIONS).unwrap_or(std::num::NonZeroU32::MIN);
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, iterations, &salt, password.as_bytes(), &mut salted);
    let key = hmac::Key::new(hmac::HMAC_SHA256, &salted);
    let client_key = hmac::sign(&key, b"Client Key");
    let stored_key = digest::digest(&digest::SHA256, client_key.as_ref());
    let server_key = hmac::sign(&key, b"Server Key");
    let b64 = base64::engine::general_purpose::STANDARD;
    format!(
        "SCRAM-SHA-256${ITERATIONS}:{}${}:{}",
        b64.encode(salt),
        b64.encode(stored_key.as_ref()),
        b64.encode(server_key.as_ref())
    )
}

async fn set_role_password(pool: &sqlx::PgPool, password: &str) -> anyhow::Result<()> {
    // ALTER ROLE takes no bind parameters; the verifier is base64 and `$`/`:` only.
    let sql = format!("ALTER ROLE CURRENT_USER PASSWORD '{}'", scram_verifier(password));
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(pool).await?;
    Ok(())
}

/// DATABASE_URL with `password` in place of the current one.
fn with_password(url: &str, password: &str) -> anyhow::Result<String> {
    let mut parsed = url::Url::parse(url).context("DATABASE_URL is not a valid URL")?;
    parsed.set_password(Some(password)).map_err(|_| anyhow::anyhow!("DATABASE_URL cannot hold a password"))?;
    Ok(parsed.to_string())
}

async fn can_connect(url: &str) -> bool {
    let Ok(options) = sqlx::postgres::PgConnectOptions::from_str(url) else { return false };
    match sqlx::postgres::PgPoolOptions::new().max_connections(1).connect_with(options).await {
        Ok(pool) => {
            let ok = sqlx::query("SELECT 1").execute(&pool).await.is_ok();
            pool.close().await;
            ok
        }
        Err(_) => false,
    }
}

async fn db_password(config: &Config, from_stdin: bool) -> anyhow::Result<()> {
    use std::io::Read;
    let password = if from_stdin {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        text.trim().to_string()
    } else {
        data_encoding::HEXLOWER.encode(&crate::crypto::random_bytes::<32>())
    };
    if password.len() < MIN_DB_PASSWORD_LENGTH {
        bail!("The new password must be at least {MIN_DB_PASSWORD_LENGTH} characters");
    }
    let current = url::Url::parse(&config.database_url)
        .ok()
        .and_then(|u| u.password().map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().to_string()));
    let env = if from_stdin { None } else { Some(env_path().context("No .env file to save the new password in")?) };
    let pool = db::connect(&config.database_url, 1).await?;
    set_role_password(&pool, &password).await?;
    let new_url = with_password(&config.database_url, &password)?;
    if !can_connect(&new_url).await {
        if let Some(current) = current {
            set_role_password(&pool, &current).await?;
        }
        bail!("The database rejected the new password, so the old one was put back. Check pg_hba.conf.");
    }
    println!("Database password changed.");
    let Some(path) = env else { return Ok(()) };
    let text = std::fs::read_to_string(&path)?;
    let updated = set_env_value(&text, "DATABASE_URL", &new_url)
        .with_context(|| format!("DATABASE_URL is not set in {}", path.display()))?;
    write_atomic(&path, &updated)?;
    println!(
        "Saved DATABASE_URL in {}. Restart the server and the worker now: new connections need it.",
        path.display()
    );
    Ok(())
}
