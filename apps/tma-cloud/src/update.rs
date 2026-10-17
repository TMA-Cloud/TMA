//! Keeps the desktop app current, as the old one did: when a newer release is
//! published, its installer downloads in the background and installs itself
//! silently, then starts the app again. The version comes from the release
//! feed the server reads; the installer from the GitHub repository set by
//! `TMA_UPDATE_REPO` at build time (TMA-Cloud/TMA by default).

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tma_client::Client;

use crate::notify_ui::Notifier;

/// The GitHub repository whose releases carry the installers, fixed when the app is built.
const REPO: &str = match option_env!("TMA_UPDATE_REPO") {
    Some(repo) => repo,
    None => "TMA-Cloud/TMA",
};
/// How often an install waiting for transfers to finish checks again.
const RETRY: Duration = Duration::from_secs(10);
/// How often a running app asks the feed again, so one left open for days still updates.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);

/// One download or install per run, even across sign-ins; cleared when it fails so a later check retries.
static BUSY: AtomicBool = AtomicBool::new(false);
/// The version the releases-page notice was shown for, so a re-check does not repeat it.
static NOTIFIED: Mutex<Option<String>> = Mutex::new(None);

/// A version from the release feed is used in a URL and its download is run; keep it strict.
pub fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Where a release's Windows installer is published.
pub fn installer_url(version: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/v{version}/tma-cloud_{version}_x64-setup.exe")
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

/// One look at the feed; on Windows, download and install a newer release.
async fn check(client: &Client, notifier: &Notifier) {
    if BUSY.load(Ordering::Relaxed) {
        return;
    }
    let Ok(latest) = client.latest_versions().await else { return };
    let Some(version) = newer_version(latest.desktop, env!("CARGO_PKG_VERSION")) else { return };
    if !cfg!(windows) {
        let mut shown = NOTIFIED.lock().unwrap_or_else(|e| e.into_inner());
        if shown.as_deref() != Some(version.as_str()) {
            notifier.info(format!("TMA Cloud {version} is available on the releases page."));
            *shown = Some(version);
        }
        return;
    }
    if BUSY.swap(true, Ordering::Relaxed) {
        return;
    }
    match fetch(&version, notifier).await {
        Some(path) => install_when_idle(path, version, notifier.clone()),
        None => BUSY.store(false, Ordering::Relaxed),
    }
}

/// Download the installer into the app's own folder, replacing any older one.
async fn fetch(version: &str, notifier: &Notifier) -> Option<std::path::PathBuf> {
    let dir = dirs::data_local_dir()?.join("TMA Cloud").join("updates");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("tma-cloud-{version}-setup.exe"));
    let progress = notifier.track_download(&format!("TMA Cloud {version}"));
    match download(&installer_url(version), &path, &progress).await {
        Ok(()) => {
            notifier.finish_download(&progress, None);
            Some(path)
        }
        Err(err) => {
            notifier.finish_download(&progress, Some(err.clone()));
            log::warn!("update download: {err}");
            None
        }
    }
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

/// Installing replaces the app, so it waits until no upload or download is running.
fn install_when_idle(installer: std::path::PathBuf, version: String, notifier: Notifier) {
    let done = Arc::new(AtomicBool::new(false));
    let _ = std::thread::Builder::new().name("update".into()).spawn(move || {
        while !done.load(Ordering::Relaxed) {
            let (installer, version, flag, closer) =
                (installer.clone(), version.clone(), done.clone(), notifier.clone());
            notifier.apply(move |app| {
                if flag.load(Ordering::Relaxed) || app.transfers_mut().is_some_and(|t| t.is_busy()) {
                    return;
                }
                flag.store(true, Ordering::Relaxed);
                // Silent, and /R starts the new version once it is installed.
                match std::process::Command::new(&installer).args(["/S", "/R"]).spawn() {
                    // Close at once: the installer ends a copy that is still running, and
                    // closing first shuts Cloud Drive down cleanly and saves the window's place.
                    Ok(_) => {
                        log::info!("installing TMA Cloud {version}");
                        closer.close_app();
                    }
                    Err(err) => {
                        app.toasts.error(format!("Could not start the update: {err}"));
                        BUSY.store(false, Ordering::Relaxed);
                    }
                }
            });
            std::thread::sleep(RETRY);
        }
    });
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
        assert!(installer_url("4.1.0").ends_with("/releases/download/v4.1.0/tma-cloud_4.1.0_x64-setup.exe"));
        assert!(installer_url("4.1.0").starts_with("https://github.com/"));
    }
}
