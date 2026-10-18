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
            #[cfg(windows)]
            let program = launch(&path, &file.name, &notifier);
            #[cfg(not(windows))]
            launch(&path, &file.name, &notifier);
            notifier.opened(&file.id);
            #[cfg(windows)]
            if let Some(program) = program {
                hold_while_running(&paths, &file, &program);
            }
        });
    });
}

/// Keep the file's edit lock while the program opened for it runs, so others get
/// it read-only meanwhile. Office and LibreOffice track each document themselves.
#[cfg(windows)]
fn hold_while_running(paths: &Paths, file: &FileItem, program: &crate::shell_open::Program) {
    if tma_drive::editing::has_owner_files(&file.name) {
        return;
    }
    let Some(core) = paths.core() else { return };
    // Someone else is editing: the drive already made it read-only and the app said so.
    if core.leases().hold(&file.id).is_some() {
        return;
    }
    program.wait();
    core.leases().let_go(&file.id);
}

/// Open a file in its app; Windows asks which app when none is set for the type.
#[cfg(windows)]
fn launch(path: &std::path::Path, name: &str, notifier: &Notifier) -> Option<crate::shell_open::Program> {
    match crate::shell_open::open(path) {
        Ok(program) => return program,
        Err(err) => log::debug!("open {}: {err}", path.display()),
    }
    if std::process::Command::new("rundll32.exe").arg("shell32.dll,OpenAs_RunDLL").arg(path).spawn().is_err() {
        notifier.error(format!("No app opens {name}"));
    }
    None
}

/// Open a file in its app.
#[cfg(not(windows))]
fn launch(path: &std::path::Path, name: &str, notifier: &Notifier) {
    if open::that_detached(path).is_err() {
        notifier.error(format!("No app opens {name}"));
    }
}
