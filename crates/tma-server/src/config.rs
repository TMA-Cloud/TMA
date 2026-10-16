//! Environment configuration. Values come from the process environment, with
//! the repository's `.env` filled in underneath for local runs. Everything an
//! administrator can change at runtime lives in `app_settings` instead.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};

/// Settings fixed for the life of the process.
#[derive(Debug, Clone)]
pub struct Config {
    pub production: bool,
    pub port: u16,
    pub backend_url: Option<String>,
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub force_insecure_cookies: bool,
    pub metrics_allowed_ips: Vec<String>,
    /// The release feed behind `/api/version/latest`.
    pub versions_url: String,
    pub worker_concurrency: usize,
    pub web_dist_dir: Option<PathBuf>,
    pub onlyoffice_reject_unauthorized: bool,
    pub held_cursor_limit: usize,
}

/// Read `NAME`, or the file `NAME_FILE` points at (Docker and Kubernetes secrets).
pub fn read_secret(name: &str) -> Result<Option<String>> {
    let direct = std::env::var(name).ok().filter(|v| !v.is_empty());
    let file = std::env::var(format!("{name}_FILE")).ok().filter(|v| !v.is_empty());
    match (direct, file) {
        (Some(_), Some(_)) => bail!("Set either {name} or {name}_FILE, not both"),
        (Some(value), None) => Ok(Some(value)),
        (None, Some(path)) => {
            let text = std::fs::read_to_string(&path).with_context(|| format!("Cannot read {name}_FILE ({path})"))?;
            let value = text.trim().to_string();
            if value.is_empty() {
                bail!("{name}_FILE ({path}) is empty");
            }
            Ok(Some(value))
        }
        (None, None) => Ok(None),
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).map(|v| v.eq_ignore_ascii_case("true") || v == "1").unwrap_or(false)
}

fn required(name: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .with_context(|| format!("{name} is not set. See .env.example for the format."))
}

/// Load `.env` from the working directory or any parent, without overriding the real environment.
pub fn load_dotenv() {
    let mut dir = std::env::current_dir().ok();
    while let Some(d) = dir {
        let candidate = d.join(".env");
        if candidate.is_file() {
            let _ = dotenvy::from_path(&candidate);
            return;
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
}

/// Published from the TMA-Cloud/updates repository.
const DEFAULT_VERSIONS_URL: &str = "https://tma-cloud.github.io/updates/versions.json";

impl Config {
    pub fn from_env() -> Result<Self> {
        let env = std::env::var("APP_ENV").or_else(|_| std::env::var("NODE_ENV")).unwrap_or_default();
        let production = env.eq_ignore_ascii_case("production");
        let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3000);
        let jwt_secret = read_secret("JWT_SECRET")?.context("JWT_SECRET environment variable is required")?;
        let metrics_allowed_ips = std::env::var("METRICS_ALLOWED_IPS")
            .unwrap_or_else(|_| "127.0.0.1,::ffff:127.0.0.1,::1".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let worker_concurrency =
            std::env::var("AUDIT_WORKER_CONCURRENCY").ok().and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or(5);
        Ok(Self {
            production,
            port,
            backend_url: std::env::var("BACKEND_URL")
                .ok()
                .map(|u| u.trim_end_matches('/').to_string())
                .filter(|u| !u.is_empty()),
            database_url: required("DATABASE_URL")?,
            redis_url: required("REDIS_URL")?,
            jwt_secret,
            force_insecure_cookies: env_flag("FORCE_INSECURE_COOKIES"),
            metrics_allowed_ips,
            versions_url: std::env::var("VERSIONS_URL")
                .ok()
                .filter(|u| u.starts_with("https://"))
                .unwrap_or_else(|| DEFAULT_VERSIONS_URL.into()),
            worker_concurrency,
            web_dist_dir: locate_web_dist(),
            onlyoffice_reject_unauthorized: std::env::var("ONLYOFFICE_REJECT_UNAUTHORIZED")
                .map(|v| v != "false")
                .unwrap_or(true),
            held_cursor_limit: std::env::var("DB_HELD_CURSOR_LIMIT")
                .ok()
                .and_then(|v| v.parse().ok())
                .filter(|n| *n > 0)
                .unwrap_or(3),
        })
    }

    /// Cookies are Secure in production unless the instance is served over plain HTTP.
    pub fn secure_cookies(&self) -> bool {
        if !self.production || self.force_insecure_cookies {
            return false;
        }
        !self.backend_url.as_deref().unwrap_or("").to_ascii_lowercase().starts_with("http://")
    }
}

/// The built web app: `WEB_DIST_DIR`, the Docker layout, or the workspace's trunk output.
fn locate_web_dist() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("WEB_DIST_DIR") {
        let path = PathBuf::from(dir);
        return path.join("index.html").is_file().then_some(path);
    }
    let mut candidates = vec![PathBuf::from("/app/web")];
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd.as_path());
        while let Some(d) = dir {
            candidates.push(d.join("apps").join("tma-cloud-web").join("dist"));
            dir = d.parent();
        }
    }
    candidates.into_iter().find(|p| p.join("index.html").is_file())
}
