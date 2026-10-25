//! Keeps the desktop app current: when a newer release is published and no transfer
//! is running, it downloads and replaces this copy behind a card over the blurred app
//! (see `overlay`), then the new version starts. Windows runs the silent installer; a Linux AppImage and a
//! macOS app bundle are swapped in place. Other installs (a .deb, a folder the user
//! cannot write) get a notice and the releases page instead. The version comes from
//! the release feed the server reads; the files from the GitHub repository set by
//! `TMA_UPDATE_REPO` at build time (TMA-Cloud/TMA by default).

mod blur;
mod install;
pub mod overlay;
pub mod target;

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tma_client::Client;

use crate::notify_ui::Notifier;
use target::Target;

/// The GitHub repository whose releases carry the installers, fixed when the app is built.
const REPO: &str = match option_env!("TMA_UPDATE_REPO") {
    Some(repo) => repo,
    None => "TMA-Cloud/TMA",
};
/// How often an install waiting for transfers to finish checks again.
const RETRY: Duration = Duration::from_secs(10);
/// How often a running app asks the feed again, so one left open for days still updates.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);
/// How long "Installing" shows before the app closes.
const CLOSE_AFTER: Duration = Duration::from_millis(1500);

/// One download or install per run, even across sign-ins; cleared when it fails so a later check retries.
static BUSY: AtomicBool = AtomicBool::new(false);
/// The version the releases-page notice was shown for, so a re-check does not repeat it.
static NOTIFIED: Mutex<Option<String>> = Mutex::new(None);
/// An update in place and waiting for the app to close, for `finish`.
static PENDING: Mutex<Option<(Target, PathBuf)>> = Mutex::new(None);

/// A version from the release feed is used in a URL and its download is run; keep it strict.
pub fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Where a release asset is published.
pub fn asset_url(version: &str, asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/v{version}/{asset}")
}

/// Where people whose install cannot update itself download a new release by hand.
pub fn releases_url() -> String {
    format!("https://github.com/{REPO}/releases/latest")
}

/// How this copy updates itself, worked out once; `None` means by hand.
pub fn target() -> Option<&'static Target> {
    static TARGET: OnceLock<Option<Target>> = OnceLock::new();
    TARGET.get_or_init(target::detect).as_ref()
}

/// Check the feed once now, for Check now in Settings > Updates.
pub fn check_now(client: Client, notifier: Notifier) {
    tma_client::rt::spawn(async move { check(&client, &notifier).await });
}

/// The feed's desktop version when it is newer than this app.
pub fn newer_version(latest: Option<String>, current: &str) -> Option<String> {
    latest.filter(|v| valid_version(v) && tma_core::is_newer_version(v, current))
}

/// Check the release feed now, then every few hours until `stop` is set (sign-out).
pub fn watch(client: Client, notifier: Notifier, stop: Arc<AtomicBool>) {
    tma_client::rt::spawn(async move {
        while !stop.load(Ordering::Relaxed) {
            check(&client, &notifier).await;
            let mut waited = Duration::ZERO;
            while waited < RECHECK && !stop.load(Ordering::Relaxed) {
                tma_client::rt::sleep(Duration::from_secs(60)).await;
                waited += Duration::from_secs(60);
            }
        }
    });
}

/// One look at the feed; download and install a newer release, or say where to get it.
async fn check(client: &Client, notifier: &Notifier) {
    if BUSY.load(Ordering::Relaxed) {
        return;
    }
    let Ok(latest) = client.latest_versions().await else { return };
    let Some(version) = newer_version(latest.desktop, env!("CARGO_PKG_VERSION")) else { return };
    let Some(target) = target() else {
        let mut shown = NOTIFIED.lock().unwrap_or_else(|e| e.into_inner());
        if shown.as_deref() != Some(version.as_str()) {
            notifier.info(format!("TMA Cloud {version} is available. Settings > Updates has the download."));
            *shown = Some(version);
        }
        return;
    };
    if BUSY.swap(true, Ordering::Relaxed) {
        return;
    }
    update_when_idle(target.clone(), version, notifier.clone());
}

/// Where the download goes: the app's own folder, or beside the AppImage so the swap is one rename.
fn download_path(target: &Target, version: &str) -> Option<PathBuf> {
    let updates = || -> Option<PathBuf> {
        let dir = dirs::data_local_dir()?.join("TMA Cloud").join("updates");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    };
    Some(match target {
        Target::Installer => updates()?.join(format!("tma-cloud-{version}-setup.exe")),
        Target::Bundle(_) => updates()?.join(format!("tma-cloud-{version}.dmg")),
        Target::AppImage(path) => path.parent()?.join(".tma-cloud-update.AppImage"),
    })
}

/// Download the release for `target`, counting into `progress`.
async fn fetch(target: &Target, version: &str, progress: &tma_client::Progress) -> Result<PathBuf, String> {
    let path = download_path(target, version).ok_or("no folder to download the update to")?;
    let result = download(&asset_url(version, &target.asset(version)), &path, progress).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result.map(|()| path)
}

async fn download(url: &str, path: &std::path::Path, progress: &tma_client::Progress) -> Result<(), String> {
    // Without timeouts a stalled download would hold the update for the whole run.
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = http.get(url).send().await.map_err(|e| e.to_string())?;
    // A redirect must not hand over the installer without TLS.
    if response.url().scheme() != "https" {
        return Err("The update was redirected off https".into());
    }
    if !response.status().is_success() {
        return Err(format!("The update is not published yet ({})", response.status()));
    }
    progress.total.store(response.content_length().unwrap_or(0), Ordering::Relaxed);
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        progress.done.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    file.sync_all().map_err(|e| e.to_string())
}

/// Start the Windows installer once the app it replaces has closed (the last thing `main` does).
pub fn finish() {
    let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some((target, download)) = pending
        && let Err(err) = install::launch(&target, &download)
    {
        log::warn!("update launch: {err}");
    }
}

/// Installing replaces the app, so it waits until no upload or download is running.
/// Then the card covers the app while the release downloads and the new copy is put
/// in place, and the app closes; `finish` starts the new version after Cloud Drive has
/// shut down cleanly and the window's place is saved.
fn update_when_idle(target: Target, version: String, notifier: Notifier) {
    let _ = std::thread::Builder::new().name("update".into()).spawn(move || {
        wait_until_idle(&notifier);
        let progress = tma_client::Progress::new(0);
        show(&notifier, &version, overlay::Step::Downloading(progress.clone()));
        let installed = tma_client::rt::block_on(fetch(&target, &version, &progress))
            .map_err(|err| format!("Could not download the update: {err}"))
            .and_then(|download| {
                show(&notifier, &version, overlay::Step::Installing);
                install(target, download).map_err(|err| format!("Could not install the update: {err}"))
            });
        match installed {
            Ok(()) => {
                log::info!("installing TMA Cloud {version}");
                // Long enough to read that the app will reopen.
                std::thread::sleep(CLOSE_AFTER);
                notifier.close_app();
            }
            Err(err) => {
                log::warn!("update: {err}");
                overlay::set(None);
                notifier.error(err);
                BUSY.store(false, Ordering::Relaxed);
            }
        }
    });
}

/// Block until a frame finds no upload or download running.
fn wait_until_idle(notifier: &Notifier) {
    let (idle_tx, idle) = std::sync::mpsc::channel();
    loop {
        let tx = idle_tx.clone();
        notifier.apply(move |app| {
            if !app.transfers_mut().is_some_and(|t| t.is_busy()) {
                let _ = tx.send(());
            }
        });
        if idle.recv_timeout(RETRY).is_ok() {
            return;
        }
    }
}

fn show(notifier: &Notifier, version: &str, step: overlay::Step) {
    overlay::set(Some(overlay::Status { version: version.to_string(), step }));
    notifier.repaint();
}

/// Put the new copy in place; the Windows installer waits for `finish`.
fn install(target: Target, download: PathBuf) -> Result<(), String> {
    install::prepare(&target, &download)?;
    if install::after_exit(&target) {
        *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some((target, download));
        Ok(())
    } else {
        install::launch(&target, &download)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_plain_versions_update() {
        assert_eq!(newer_version(Some("4.0.1".into()), "4.0.0").as_deref(), Some("4.0.1"));
        assert_eq!(newer_version(Some("4.0.0".into()), "4.0.0"), None);
        assert_eq!(newer_version(Some("3.9.9".into()), "4.0.0"), None);
        assert_eq!(newer_version(Some("unknown".into()), "4.0.0"), None);
        assert_eq!(newer_version(None, "4.0.0"), None);
    }

    #[test]
    fn only_plain_versions_reach_the_url() {
        assert!(valid_version("4.1.0"));
        assert!(!valid_version("4.1"));
        assert!(!valid_version("4.1.0/../../x"));
        assert!(!valid_version("v4.1.0"));
        let url = asset_url("4.1.0", &Target::Installer.asset("4.1.0"));
        assert_eq!(url, format!("https://github.com/{REPO}/releases/download/v4.1.0/tma-cloud_4.1.0_x64-setup.exe"));
    }
}
