//! Command line: run the server or worker, and the admin tasks `rotate.sh` and
//! operators call (migrations, keys, rotation, bucket hardening, bulk import).

mod import;
mod rotate;
mod s3;

use std::path::PathBuf;

use clap::{Parser, Subcommand};

use crate::config::Config;
use crate::crypto::generate_key;
use crate::db;
use crate::server::{self, Role};

#[derive(Parser)]
#[command(name = "tma-server", version, about = "TMA Cloud server")]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the API and web app (the default).
    Serve {
        /// Also run the background worker in this process.
        #[arg(long)]
        with_worker: bool,
    },
    /// Run the background worker only.
    Worker,
    /// Apply database migrations and exit.
    Migrate,
    /// Generate a new random master key.
    Key {
        #[command(subcommand)]
        action: KeyAction,
    },
    /// Rotate the master key or the database password.
    Rotate {
        #[command(subcommand)]
        action: RotateAction,
    },
    /// Harden the storage bucket (private, HTTPS only, versioned, encrypted).
    S3 {
        #[command(subcommand)]
        action: S3Action,
    },
    /// Import a folder tree from disk into an account, encrypted like uploads.
    Import(ImportArgs),
    /// Exit 0 when this container's server answers /health (for Docker health checks).
    Healthcheck,
}

#[derive(Subcommand)]
enum KeyAction {
    /// Print a random 32-byte key in base64.
    Generate,
}

#[derive(Subcommand)]
pub enum RotateAction {
    /// Show which key versions stored data uses.
    Status,
    /// Add a new master key version; new files use it from the next restart.
    Key,
    /// Rewrap every stored key to the newest version now.
    Rewrap,
    /// Change the database role's password and save it in DATABASE_URL.
    DbPassword {
        /// Read the new password from standard input instead of generating one (nothing is saved).
        #[arg(long)]
        stdin: bool,
    },
}

#[derive(Subcommand, Clone, Copy)]
pub enum S3Action {
    /// Abort unfinished multipart uploads after a day and expire old versions after a week.
    Lifecycle,
    /// Print the bucket's lifecycle rules.
    CheckLifecycle,
    /// Block every form of public access.
    PublicBlock,
    /// Deny requests that do not use HTTPS.
    PolicyHttps,
    /// Keep previous versions of overwritten or deleted objects.
    Versioning,
    /// Encrypt objects at rest by default (SSE-S3).
    Encryption,
    /// All of the above.
    ProtectAll,
}

#[derive(clap::Args)]
pub struct ImportArgs {
    /// Root folder on disk to import.
    #[arg(long)]
    pub source_dir: PathBuf,
    /// Owner of the imported files, by id.
    #[arg(long, conflicts_with = "user_email")]
    pub user_id: Option<String>,
    /// Owner of the imported files, by email.
    #[arg(long)]
    pub user_email: Option<String>,
    /// Files uploaded at once.
    #[arg(long, default_value_t = 2)]
    pub concurrency: usize,
    /// Only report what would be imported.
    #[arg(long)]
    pub dry_run: bool,
}

pub async fn run() -> anyhow::Result<()> {
    crate::config::load_dotenv();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve { with_worker: false }) {
        Command::Serve { with_worker } => {
            server::init_tracing();
            server::run(Config::from_env()?, if with_worker { Role::Both } else { Role::Api }).await
        }
        Command::Worker => {
            server::init_tracing();
            server::run(Config::from_env()?, Role::Worker).await
        }
        Command::Migrate => {
            server::init_tracing();
            let pool = db::connect(&Config::from_env()?.database_url, 2).await?;
            db::run_migrations(&pool).await?;
            println!("Migrations applied.");
            Ok(())
        }
        Command::Key { action: KeyAction::Generate } => {
            println!("{}", generate_key());
            Ok(())
        }
        Command::Rotate { action } => rotate::run(action).await,
        Command::S3 { action } => s3::run(action).await,
        Command::Import(args) => import::run(args).await,
        Command::Healthcheck => healthcheck().await,
    }
}

async fn healthcheck() -> anyhow::Result<()> {
    let port = std::env::var("PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3000);
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/health"))
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await?;
    anyhow::ensure!(response.status().is_success(), "health check returned {}", response.status());
    Ok(())
}

/// The `.env` the server loaded, searched from the working directory upwards.
fn env_path() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok();
    while let Some(d) = dir {
        let candidate = d.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
    None
}

/// Write via a temporary file and rename, so a crash never leaves half a file.
fn write_atomic(path: &std::path::Path, text: &str) -> anyhow::Result<()> {
    use anyhow::Context;
    let tmp = path.with_extension("tmp-rotate");
    std::fs::write(&tmp, text).with_context(|| {
        format!("{} is read-only here. On a Docker install, run the script on the host.", path.display())
    })?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Replace `KEY=...` in an env file's text; `None` when the key is not set there.
fn set_env_value(text: &str, key: &str, value: &str) -> Option<String> {
    let prefix = format!("{key}=");
    let mut found = false;
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            if line.trim_start().starts_with(&prefix) {
                found = true;
                format!("{key}={value}")
            } else {
                line.to_string()
            }
        })
        .collect();
    found.then(|| lines.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_values() {
        assert_eq!(set_env_value("A=1\nB=2\n", "B", "3").as_deref(), Some("A=1\nB=3\n"));
        assert!(set_env_value("A=1\n", "B", "3").is_none());
    }
}
