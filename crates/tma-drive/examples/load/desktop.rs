//! Simulated desktop apps. Each signs in as one of the load-test accounts, holds
//! the event stream open, sends the 60 s heartbeat, keeps a set of folders "open"
//! the way Cloud Drive does (listing again those the change feed names, once per
//! burst of events or once a minute, all of them on a reset), and does the work
//! production's audit log shows, in its proportions.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tma_client::Client;
use tma_drive::{Backend, ClientBackend};

use crate::corpus::{Corpus, File};
use crate::rng::Rng;
use crate::stats::Stats;
use crate::{block, email, sign_in};

pub struct Plan {
    pub apps: usize,
    /// Folders each app keeps open (populated, in Cloud Files terms).
    pub open: usize,
    /// Actions per minute per app; production peaks near 3 across all users.
    pub per_minute: f64,
    pub seconds: u64,
}

/// What every app thread shares.
struct Shared {
    base: String,
    accounts: Vec<String>,
    corpus: Corpus,
    stats: Stats,
    stop: AtomicBool,
    events: AtomicU64,
}

pub fn run(base: &str, plan: &Plan) -> Result<(), String> {
    let owner = sign_in(base, &email(0))?;
    let mut accounts = vec![email(0)];
    let subs = block(owner.sub_users()).map_err(|e| e.message)?;
    accounts.extend(subs.sub_users.into_iter().map(|s| s.email).filter(|e| e.ends_with("@load.test")));
    let corpus = Corpus::walk(&owner)?;
    println!("{} folders, {} files, {} accounts", corpus.folders.len(), corpus.files.len(), accounts.len());
    let shared = Arc::new(Shared {
        base: base.into(),
        accounts,
        corpus,
        stats: Stats::default(),
        stop: AtomicBool::new(false),
        events: AtomicU64::new(0),
    });
    let mut apps = Vec::new();
    for n in 0..plan.apps {
        let (shared, open, per_minute) = (shared.clone(), plan.open, plan.per_minute);
        apps.push(std::thread::spawn(move || app(n, &shared, open, per_minute)));
        std::thread::sleep(Duration::from_millis(50));
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(plan.seconds) {
        std::thread::sleep(Duration::from_secs(15));
        shared.stats.report(started.elapsed(), shared.events.load(Ordering::Relaxed));
    }
    shared.stop.store(true, Ordering::Relaxed);
    for app in apps {
        let _ = app.join();
    }
    println!("=== final ===");
    shared.stats.report(started.elapsed(), shared.events.load(Ordering::Relaxed));
    shared.stats.reasons();
    Ok(())
}

/// One desktop app, until the run stops.
fn app(n: usize, shared: &Arc<Shared>, open: usize, per_minute: f64) {
    let account = &shared.accounts[n % shared.accounts.len()];
    let Some(client) = shared.stats.time("sign-in", || sign_in(&shared.base, account)) else { return };
    let backend = Arc::new(ClientBackend::new(client.clone()));
    let generation = Arc::new(AtomicU64::new(0));
    let (wake, all) = (generation.clone(), shared.clone());
    let _stream = tma_client::events::subscribe(
        &client,
        Arc::new(move |_| {
            wake.fetch_add(1, Ordering::Relaxed);
            all.events.fetch_add(1, Ordering::Relaxed);
        }),
    );
    let mut rng = Rng::new(n as u64);
    let mut opened: Vec<Option<String>> = vec![None];
    opened.extend(rng.sample(&shared.corpus.folders, open).into_iter().map(Some));
    let sync = {
        let (backend, generation, shared) = (backend.clone(), generation.clone(), shared.clone());
        std::thread::spawn(move || follow_changes(&backend, &generation, &shared, &opened))
    };
    let client_id = format!("load-app-{n}");
    let mut beat = Instant::now() - Duration::from_secs(60);
    let mut mine: Vec<String> = Vec::new();
    while !shared.stop.load(Ordering::Relaxed) {
        if beat.elapsed() >= Duration::from_secs(60) {
            beat = Instant::now();
            shared.stats.time("heartbeat", || {
                block(client.client_heartbeat("4.0.0", "windows", &client_id)).map_err(|e| e.message)
            });
        }
        // Poisson arrivals at per_minute a minute.
        let wait = -(1.0 - rng.unit()).ln() * 60.0 / per_minute.max(0.0001);
        let until = Instant::now() + Duration::from_secs_f64(wait.min(60.0));
        while Instant::now() < until && !shared.stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(100).min(until.saturating_duration_since(Instant::now())));
        }
        if !shared.stop.load(Ordering::Relaxed) && wait <= 60.0 {
            work(&client, &backend, shared, &mut rng, &mut mine);
        }
    }
    let _ = sync.join();
}

/// The Cloud Drive worker's rule (cloud_files::feed): a full pass first and on a
/// reset, otherwise only the changed folders this app has open.
fn follow_changes(backend: &ClientBackend, generation: &AtomicU64, shared: &Shared, opened: &[Option<String>]) {
    let full = || -> Option<String> {
        let cursor = shared.stats.time("changes", || backend.changes(None)).map(|c| c.cursor);
        let pass = Instant::now();
        for folder in opened {
            shared.stats.time("list", || backend.list(folder.as_deref()));
        }
        shared.stats.record("full pass", pass.elapsed());
        cursor
    };
    let mut cursor = full();
    let mut seen = generation.load(Ordering::Relaxed);
    let (mut asked, mut pending) = (Instant::now(), false);
    while !shared.stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(500));
        let now = generation.load(Ordering::Relaxed);
        pending |= now != seen;
        seen = now;
        let due = (pending && asked.elapsed() >= Duration::from_secs(1)) || asked.elapsed() >= Duration::from_secs(60);
        if !due {
            continue;
        }
        (asked, pending) = (Instant::now(), false);
        let Some(changes) = shared.stats.time("changes", || backend.changes(cursor.as_deref())) else { continue };
        if changes.reset {
            cursor = full();
            continue;
        }
        for folder in changes.folders.iter().filter(|f| opened.contains(f)) {
            shared.stats.time("list", || backend.list(folder.as_deref()));
        }
        cursor = Some(changes.cursor);
    }
}

/// One action in production's mix: downloads 55%, saves 26%, uploads 7%, then
/// trash, renames, copies, new folders and moves. Only this app's own uploads
/// are trashed or moved, so the seeded tree stays intact.
fn work(client: &Client, backend: &ClientBackend, shared: &Shared, rng: &mut Rng, mine: &mut Vec<String>) {
    let stats = &shared.stats;
    let Some(File { id, folder, name }) = rng.pick(&shared.corpus.files).cloned() else { return };
    let roll = rng.unit();
    if roll < 0.55 {
        stats.time("download", || backend.download_with(&id, &mut |_| Ok(())));
    } else if roll < 0.81 {
        save(backend, stats, rng, (&id, folder.as_deref(), &name));
    } else if roll < 0.88 {
        let name = format!("Upload {}.pdf", rng.next());
        let body = rng.body(512 * 1024);
        if let Some(new) = stats.time("upload", || crate::seed::upload(client, folder.as_deref(), &name, body)) {
            mine.push(new);
        }
    } else if roll < 0.91 {
        if let Some(own) = mine.pop() {
            stats.time("trash", || backend.delete(&own));
        }
    } else if roll < 0.94 {
        stats.time("rename", || backend.rename(&id, &format!("{name}.tmp")));
        stats.time("rename", || backend.rename(&id, &name));
    } else if roll < 0.96 {
        let target = rng.pick(&shared.corpus.folders).cloned();
        stats.time("copy", || {
            block(client.copy_items(std::slice::from_ref(&id), target.as_deref())).map_err(|e| e.message)
        });
    } else if roll < 0.98 {
        let name = format!("New folder {}", rng.next());
        stats.time("new folder", || backend.mkdir(folder.as_deref(), &name));
    } else if let Some(own) = mine.last().cloned() {
        let target = rng.pick(&shared.corpus.folders).cloned();
        stats.time("move", || backend.move_to(&own, target.as_deref()));
    }
}

/// Edit in place as the drive does: take the lock, save against the version the
/// folder listing shows, let the lock go.
fn save(backend: &ClientBackend, stats: &Stats, rng: &mut Rng, (id, folder, name): (&str, Option<&str>, &str)) {
    if stats.time("lock", || backend.lock(id).map(|_| ())).is_none() {
        return;
    }
    let version = backend.list(folder).ok().and_then(|l| l.into_iter().find(|e| e.id == id)).map(|e| e.version);
    let path = std::env::temp_dir().join(format!("tma-load-{}.bin", rng.next()));
    if std::fs::write(&path, rng.body(512 * 1024)).is_ok() {
        stats.time("save", || backend.replace(id, name, &path, version.filter(|v| *v > 0)));
        let _ = std::fs::remove_file(&path);
    }
    stats.time("unlock", || backend.unlock(id));
}
