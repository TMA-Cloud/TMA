//! Keeps the desktop app current, as the old one did: when a newer release is
//! published, its installer downloads in the background and installs itself
//! silently, then starts the app again. The version comes from the release
//! feed the server reads; the installer from the GitHub repository set by
//! `TMA_UPDATE_REPO` at build time (TMA-Cloud/TMA by default).

use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tma_client::Client;

use crate::notify_ui::Notifier;

/// The GitHub repository whose releases carry the installers, fixed when the app is built.
const REPO: &str = match option_env!("TMA_UPDATE_REPO") {
    Some(repo) => repo,
    None => "TMA-Cloud/TMA",
};
/// How often an install waiting for transfers to finish checks again.
const RETRY: std::time::Duration = std::time::Duration::from_secs(10);

/// A version from the release feed is used in a URL and its download is run; keep it strict.
pub fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Where a release's Windows installer is published.
pub fn installer_url(version: &str) -> String {
    format!("https://github.com/{REPO}/releases/download/v{version}/tma-cloud_{version}_x64-setup.exe")
}

/// Check the release feed once; on Windows, download and install a newer release.
pub fn check(client: Client, notifier: Notifier) {
    tma_client::rt::spawn(async move {
        let Ok(latest) = client.latest_versions().await else { return };
        let Some(version) = latest.desktop.filter(|v| valid_version(v)) else { return };
        if !tma_core::is_newer_version(&version, env!("CARGO_PKG_VERSION")) {
            return;
        }
        if !cfg!(windows) {
            notifier.info(format!("TMA Cloud {version} is available on the releases page."));
            return;
        }
        let progress = notifier.track_download(&format!("TMA Cloud {version}"));
        let path = std::env::temp_dir().join(format!("tma-cloud-{version}-setup.exe"));
        match download(&installer_url(&version), &path, &progress).await {
            Ok(()) => notifier.finish_download(&progress, None),
            Err(err) => {
                notifier.finish_download(&progress, Some(err.clone()));
                log::warn!("update download: {err}");
                return;
            }
        }
        install_when_idle(path, version, notifier);
    });
}

async fn download(url: &str, path: &std::path::Path, progress: &tma_client::Progress) -> Result<(), String> {
    let mut response = reqwest::get(url).await.map_err(|e| e.to_string())?;
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

/// Installing closes the app, so it waits until no upload or download is running.
fn install_when_idle(installer: std::path::PathBuf, version: String, notifier: Notifier) {
    let started = Arc::new(AtomicBool::new(false));
    let _ = std::thread::Builder::new().name("update".into()).spawn(move || {
        while !started.load(Ordering::Relaxed) {
            let (installer, version, flag) = (installer.clone(), version.clone(), started.clone());
            notifier.apply(move |app| {
                if flag.load(Ordering::Relaxed) || app.transfers_mut().is_some_and(|t| t.is_busy()) {
                    return;
                }
                flag.store(true, Ordering::Relaxed);
                // Silent, and /R starts the new version once it is installed.
                match std::process::Command::new(&installer).args(["/S", "/R"]).spawn() {
                    Ok(_) => app.toasts.info(format!("Installing TMA Cloud {version}. It restarts in a moment.")),
                    Err(err) => app.toasts.error(format!("Could not start the update: {err}")),
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
    fn only_plain_versions_reach_the_url() {
        assert!(valid_version("4.1.0"));
        assert!(!valid_version("4.1"));
        assert!(!valid_version("4.1.0/../../x"));
        assert!(!valid_version("v4.1.0"));
        assert!(installer_url("4.1.0").ends_with("/releases/download/v4.1.0/tma-cloud_4.1.0_x64-setup.exe"));
        assert!(installer_url("4.1.0").starts_with("https://github.com/"));
    }
}
