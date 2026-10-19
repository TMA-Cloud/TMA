//! Startup: build the shared state, then serve HTTP, run the worker, or both.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use tokio::sync::watch;

use crate::config::Config;
use crate::crypto::Keyring;
use crate::services::access::AccessTracker;
use crate::services::audit::AuditLog;
use crate::services::events::EventHub;
use crate::services::limits::RateLimits;
use crate::services::metrics::Metrics;
use crate::settings::SettingsCache;
use crate::state::{AppState, Inner};
use crate::storage::Storage;
use crate::{cache, db, jobs, routes, services};

/// How long in-flight requests get after SIGTERM before their connections are closed.
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Listen on every address, IPv6 and IPv4 alike. A client that tries IPv6 first
/// (Windows does for localhost, anyone does for a name with an IPv6 address)
/// otherwise waits 300 ms to 2 s per connection before falling back. Windows
/// makes IPv6 sockets IPv6-only unless told otherwise, hence socket2. A host
/// whose kernel has no IPv6 at all gets IPv4 only.
fn listen(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Socket, Type};
    let open = |domain: Domain, addr: SocketAddr| -> std::io::Result<Socket> {
        let socket = Socket::new(domain, Type::STREAM, None)?;
        if domain == Domain::IPV6 {
            socket.set_only_v6(false)?;
        }
        // As tokio's own bind does, so a restarted server can take the port at once.
        #[cfg(unix)]
        socket.set_reuse_address(true)?;
        socket.set_nonblocking(true)?;
        socket.bind(&addr.into())?;
        socket.listen(1024)?;
        Ok(socket)
    };
    let socket = match open(Domain::IPV6, SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port))) {
        Ok(socket) => {
            tracing::info!(port, "Server listening on IPv6 and IPv4");
            socket
        }
        Err(err) => {
            tracing::info!(port, reason = %err, "Server listening on IPv4 only");
            open(Domain::IPV4, SocketAddr::from(([0, 0, 0, 0], port)))?
        }
    };
    tokio::net::TcpListener::from_std(socket.into())
}

/// What this process runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Api,
    Worker,
    Both,
}

pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    // RUST_LOG takes full filter syntax; LOG_LEVEL is the simple knob .env files set.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        let level = std::env::var("LOG_LEVEL")
            .ok()
            .filter(|l| matches!(l.as_str(), "trace" | "debug" | "info" | "warn" | "error"))
            .unwrap_or_else(|| "info".into());
        EnvFilter::new(format!("{level},sqlx=warn,aws_config=warn,aws_smithy_runtime=warn"))
    });
    // Colour codes only help a terminal; in a log file or container log they are noise.
    let ansi = std::io::IsTerminal::is_terminal(&std::io::stdout());
    let builder = tracing_subscriber::fmt().with_env_filter(filter).with_target(false).with_ansi(ansi);
    if std::env::var("LOG_FORMAT").is_ok_and(|v| v == "json") { builder.json().init() } else { builder.init() }
}

/// Connect everything and verify the master key; a wrong key stops startup here.
pub async fn build_state(config: Config, role: Role) -> anyhow::Result<AppState> {
    let keyring = Keyring::from_env(config.production, false).context("Invalid FILE_ENCRYPTION_KEY")?;
    build_state_with_keyring(config, keyring, role).await
}

/// As `build_state`, with the master keyring supplied (tests use a generated one).
pub async fn build_state_with_keyring(config: Config, keyring: Keyring, role: Role) -> anyhow::Result<AppState> {
    let keyring = Arc::new(keyring);
    let max_connections = std::env::var("DB_POOL_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(20);
    let pool = db::connect(&config.database_url, max_connections).await.context("Database connection failed")?;
    db::run_migrations(&pool).await.context("Database migrations failed")?;
    services::keys::verify(&pool, &keyring).await?;

    let settings = SettingsCache::new(pool.clone());
    let known = settings.get().await.known_proxies.clone();
    let (trusted_proxies, failures) = crate::settings::resolve_known_proxies(&known).await;
    if !failures.is_empty() {
        tracing::warn!(hostnames = ?failures, "Some known proxy hostnames could not be resolved and will not be trusted");
    }
    tracing::info!(configured = known.len(), trusted = trusted_proxies.len(), "Known proxy trust configured");

    let cache = cache::Cache::connect(&config.redis_url).await?;
    let metrics = Metrics::new()?;
    let spa_script_hashes = crate::middleware::SpaHashes::new(config.web_dist_dir.as_deref());
    if role != Role::Worker && config.web_dist_dir.is_none() {
        tracing::warn!("Web app not built (no dist directory). Non-API routes will return a graceful 404.");
    }
    // Defaults so no outbound call (storage checks, version check) can hang a request; calls may set shorter ones.
    let http = reqwest::Client::builder()
        .user_agent(concat!("tma-cloud/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let inner = Inner {
        storage: Storage::new(pool.clone(), keyring.clone()),
        jobs: jobs::JobQueue::new(pool.clone()),
        audit: AuditLog::start(pool.clone(), metrics.clone()),
        events: EventHub::new(cache.clone()),
        access: AccessTracker::new(pool.clone(), settings.clone()),
        limits: RateLimits::default(),
        config,
        pool,
        cache,
        settings,
        keyring,
        metrics,
        http,
        trusted_proxies,
        spa_script_hashes,
    };
    Ok(AppState(Arc::new(inner)))
}

/// Settings writes in another process drop this process's snapshots.
fn spawn_background(state: &AppState) {
    let listener = state.clone();
    state.events.spawn_listener(move |what| {
        let state = listener.clone();
        tokio::spawn(async move {
            state.settings.invalidate().await;
            if what == "storage" {
                state.storage.invalidate().await;
            }
        });
    });
    state.access.spawn_flusher();
    let limits = state.limits.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            limits.prune();
        }
    });
}

async fn shutdown_signal(tx: watch::Sender<bool>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    tracing::info!("Shutdown signal received");
    let _ = tx.send(true);
}

/// Rewrap keys left under an older master key; a large run must not hold up the queues.
fn spawn_rewrap(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        match services::keys::rewrap_to_primary(&state.pool, &state.keyring).await {
            Ok(r) => {
                if r.rewrapped > 0 || r.storage_secret {
                    tracing::info!(primary = r.primary, rewrapped = r.rewrapped, "[KeyRewrap] Rewrapped keys");
                }
                if !r.failures.is_empty() {
                    tracing::error!(failed = r.failures.len(), "[KeyRewrap] Some file keys could not be rewrapped");
                }
            }
            Err(err) => tracing::error!(error = %err, "[KeyRewrap] Rewrap failed; it runs again on the next start"),
        }
    });
}

pub async fn run(config: Config, role: Role) -> anyhow::Result<()> {
    routes::mark_started();
    let port = config.port;
    let state = build_state(config, role).await?;
    spawn_background(&state);
    let (tx, rx) = watch::channel(false);
    tokio::spawn(shutdown_signal(tx));

    let worker = (role != Role::Api).then(|| {
        spawn_rewrap(&state);
        let (state, rx) = (state.clone(), rx.clone());
        tokio::spawn(async move {
            if let Err(err) = jobs::worker::run(state, rx).await {
                tracing::error!(error = %format!("{err:#}"), "Worker stopped");
            }
        })
    });

    if role != Role::Worker {
        jobs::worker::spawn_depth_updater(state.jobs.clone(), state.metrics.clone());
        let app = routes::router(state.clone());
        let listener = listen(port).with_context(|| format!("Cannot listen on port {port}"))?;
        let mut stop = rx.clone();
        let serve = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async move {
                let _ = stop.wait_for(|s| *s).await;
            });
        // Event streams never end on their own; cap the drain inside Docker's 10-second stop timeout.
        let mut deadline = rx.clone();
        tokio::select! {
            result = std::future::IntoFuture::into_future(serve) => result?,
            _ = async move {
                let _ = deadline.wait_for(|s| *s).await;
                tokio::time::sleep(DRAIN_TIMEOUT).await;
            } => tracing::warn!("Closed connections still open after the shutdown grace period"),
        }
    }
    if let Some(worker) = worker {
        let _ = worker.await;
    }
    state.audit.flush().await;
    state.access.flush().await;
    tracing::info!("Stopped");
    Ok(())
}
