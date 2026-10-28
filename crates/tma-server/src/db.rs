//! The Postgres pool and the startup migration runner.

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Arbitrary constant: serialises migrations across replicas starting together.
const MIGRATION_LOCK_KEY: i64 = 7_261_900_001;

/// A pool for DATABASE_URL; the URL takes every libpq parameter psql reads.
pub async fn connect(url: &str, max_connections: u32) -> Result<PgPool> {
    let options = PgConnectOptions::from_str(url)
        .context("DATABASE_URL must be a postgresql:// URL that names a database")?
        .application_name("tma-cloud");
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(15))
        .idle_timeout(Duration::from_secs(300))
        .connect_with(options)
        .await
        .context("Failed to connect to Postgres")?;
    Ok(pool)
}

/// Apply every embedded migration not yet recorded, each atomically, under an advisory lock.
pub async fn run_migrations(pool: &PgPool) -> Result<()> {
    let mut conn = pool.acquire().await?;
    sqlx::query("SELECT pg_advisory_lock($1)").bind(MIGRATION_LOCK_KEY).execute(&mut *conn).await?;
    let result = apply_pending(&mut conn).await;
    let _ = sqlx::query("SELECT pg_advisory_unlock($1)").bind(MIGRATION_LOCK_KEY).execute(&mut *conn).await;
    result
}

async fn apply_pending(conn: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS migrations (
           version VARCHAR(255) PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )",
    )
    .execute(&mut *conn)
    .await?;
    let applied: Vec<String> = sqlx::query_scalar("SELECT version FROM migrations").fetch_all(&mut *conn).await?;
    for (version, sql) in MIGRATIONS {
        if applied.iter().any(|v| v == version) {
            continue;
        }
        tracing::info!(version, "Applying migration");
        // One transaction, so a crash can't leave a migration applied but unrecorded.
        let mut tx = sqlx::Connection::begin(&mut *conn).await?;
        sqlx::raw_sql(sqlx::AssertSqlSafe(*sql))
            .execute(&mut *tx)
            .await
            .with_context(|| format!("Migration {version} failed"))?;
        sqlx::query("INSERT INTO migrations(version) VALUES($1)").bind(version).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}
