//! Edit in a desktop app: open the file where it already is, in the Cloud Drive
//! folder. Windows downloads it when the app opens it, and the drive uploads
//! every save (and any Save As copy beside it), so no other copy is kept.

use std::time::Duration;

use tma_client::Client;
use tma_core::api::FileItem;

use crate::drive::Paths;
use crate::notify_ui::Notifier;

/// How long an opened file stays readable in save-only mode: a working session.
const EDIT_WINDOW: Duration = Duration::from_secs(12 * 3600);

/// Programs and scripts are never opened from the cloud.
const BLOCKED_EXTS: &[&str] = &[
    "exe", "dll", "bat", "cmd", "com", "pif", "scr", "vbs", "js", "jse", "ws", "wsf", "wsh", "ps1", "psm1", "msi",
    "msp", "jar", "lnk", "reg", "hta", "cpl", "sh", "app", "command",
];

pub fn open(paths: Paths, client: Client, file: FileItem, notifier: Notifier) {
    let ext = tma_core::names::extension_of(&file.name);
    if BLOCKED_EXTS.contains(&ext.as_str()) {
        notifier.opened(&file.id);
        notifier.error("Programs and scripts can't be opened from the cloud. Download the file to run it.");
        return;
    }
    tma_client::rt::spawn(async move {
        let info = match client.info(&file.id).await {
            Ok(info) => info,
            Err(err) => {
                notifier.opened(&file.id);
                notifier.error(format!("Cannot open {}: {}", file.name, err.message));
                return;
            }
        };
        let Some(path) = paths.local_path(&info.location_path, &info.name, EDIT_WINDOW) else {
            notifier.opened(&file.id);
            notifier.error(format!(
                "Cannot open {} in a desktop app because Cloud Drive is not connected. See Settings → Desktop app.",
                file.name
            ));
            return;
        };
        // Opening by path can block while Windows downloads the file; keep it off the async workers.
        let _ = std::thread::Builder::new().name("open-in-app".into()).spawn(move || {
            paths.reveal(&path);
            let opened = launch(&path, &file.name, &notifier);
            // The ring turns until the program shows the file: a program that takes seconds
            // to start must not look as if the click did nothing, or people click again.
            #[cfg(windows)]
            let shown = opened && wait_until_shown(&file.name);
            notifier.opened(&file.id);
            #[cfg(windows)]
            if shown {
                hold_while_shown(&paths, &file);
            }
            #[cfg(not(windows))]
            let _ = opened;
        });
    });
}

/// How long a program gets to show the file in a window title; the opening ring stops then
/// even for a program whose title never names its file.
#[cfg(windows)]
const APPEAR: Duration = Duration::from_secs(15);
/// How long the title may stop naming the file (a dialog, another tab) before the file counts as closed.
#[cfg(windows)]
const GONE: Duration = Duration::from_secs(15);

/// Wait until a window names the file; false if none does within `APPEAR`.
#[cfg(windows)]
fn wait_until_shown(name: &str) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < APPEAR {
        if crate::app_windows::titles().iter().any(|t| tma_drive::editing::window_shows(t, name)) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Keep the file's edit lock while a window names it, so others get it read-only
/// meanwhile. Programs are often already running or start through a launcher, so
/// their process says nothing; their title does. Office and LibreOffice track each
/// document themselves.
#[cfg(windows)]
fn hold_while_shown(paths: &Paths, file: &FileItem) {
    if tma_drive::editing::has_owner_files(&file.name) {
        return;
    }
    let Some(core) = paths.core() else { return };
    // Someone else is editing: the drive already made it read-only and the app said so.
    if core.leases().hold(&file.id).is_some() {
        return;
    }
    // Called once a window shows the file.
    let mut seen = std::time::Instant::now();
    while seen.elapsed() <= GONE {
        std::thread::sleep(Duration::from_secs(1));
        if crate::app_windows::titles().iter().any(|t| tma_drive::editing::window_shows(t, &file.name)) {
            seen = std::time::Instant::now();
        }
    }
    core.leases().let_go(&file.id);
}

/// Open a file in its app; Windows asks which app when none is set for the type.
fn launch(path: &std::path::Path, name: &str, notifier: &Notifier) -> bool {
    if open::that_detached(path).is_ok() {
        return true;
    }
    #[cfg(windows)]
    if std::process::Command::new("rundll32.exe").arg("shell32.dll,OpenAs_RunDLL").arg(path).spawn().is_ok() {
        return true;
    }
    notifier.error(format!("No app opens {name}"));
    false
}
