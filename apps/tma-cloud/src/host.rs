//! The desktop host: the session lives in the OS credential store, links open
//! in the default browser, and the app reports presence to the server.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tma_client::Client;
use tma_core::api::{FileItem, User};
use tma_ui::{Host, HostKind, SavedSession, Tasks};

use crate::drive::{Drive, Status};
use crate::notify_ui::Notifier;

/// What to open for the drive: "Z:\\" on Windows, the mount folder elsewhere.
pub fn drive_root(point: &str) -> String {
    if cfg!(windows) && point.ends_with(':') { format!("{point}\\") } else { point.to_string() }
}

/// A drive letter as is; a folder by its name, since the full path is long.
fn drive_label(point: &str) -> &str {
    std::path::Path::new(point).file_name().and_then(|n| n.to_str()).unwrap_or(point)
}

const KEYRING_SERVICE: &str = "TMA Cloud";
const HEARTBEAT_SECS: u64 = 60;

pub struct DesktopHost {
    pub server: Option<String>,
    pub client_id: String,
    heartbeat_stop: Option<Arc<AtomicBool>>,
    drive: Drive,
}

impl DesktopHost {
    pub fn new(server: Option<String>, client_id: String) -> Self {
        Self { server, client_id, heartbeat_stop: None, drive: Drive::default() }
    }

    fn entry(server: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, server).ok()
    }
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

impl Host for DesktopHost {
    fn kind(&self) -> HostKind {
        HostKind::Desktop
    }

    fn saved_session(&self) -> Option<SavedSession> {
        let server = self.server.clone()?;
        let token = Self::entry(&server).and_then(|e| e.get_password().ok()).filter(|t| !t.is_empty());
        Some(SavedSession { server, token })
    }

    fn save_session(&mut self, session: Option<&SavedSession>) {
        let Some(session) = session else {
            self.server = None;
            return;
        };
        self.server = Some(session.server.clone());
        let Some(entry) = Self::entry(&session.server) else { return };
        let result = match &session.token {
            // Saved every half minute while signed in; only a renewed token is written.
            Some(token) if entry.get_password().is_ok_and(|saved| saved == *token) => Ok(()),
            Some(token) => entry.set_password(token),
            None => match entry.delete_credential() {
                Err(keyring::Error::NoEntry) => Ok(()),
                other => other,
            },
        };
        if let Err(err) = result {
            log::warn!("Cannot update the saved sign-in: {err}");
        }
    }

    fn open_url(&self, url: &str) {
        if let Err(err) = open::that_detached(url) {
            log::warn!("Cannot open {url}: {err}");
        }
    }

    fn signed_in(&mut self, client: &Client, _user: &User, tasks: &Tasks) {
        self.drive.start(client, tasks.ctx().clone());
        if let Some(stop) = self.heartbeat_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
        let stop = Arc::new(AtomicBool::new(false));
        self.heartbeat_stop = Some(stop.clone());
        // Stops with the heartbeat at sign-out; the next sign-in starts a new one.
        crate::update::watch(client.clone(), Notifier::new(tasks), stop.clone());
        let (client, client_id, notifier) = (client.clone(), self.client_id.clone(), Notifier::new(tasks));
        tma_client::rt::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                if let Err(err) = client.client_heartbeat(env!("CARGO_PKG_VERSION"), platform(), &client_id).await
                    && err.is_unauthorized()
                {
                    // Ended elsewhere (password change, sign out everywhere): show sign-in now, not on the next click.
                    if !stop.load(Ordering::Relaxed) {
                        notifier.apply(move |app| {
                            if !stop.load(Ordering::Relaxed) {
                                app.sign_out();
                                app.toasts.info("Your session ended. Sign in again.");
                            }
                        });
                    }
                    return;
                }
                tma_client::rt::sleep(std::time::Duration::from_secs(HEARTBEAT_SECS)).await;
            }
        });
    }

    fn signed_out(&mut self) {
        self.drive.stop();
        if let Some(stop) = self.heartbeat_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    fn settings_title(&self) -> Option<&'static str> {
        Some("Desktop app")
    }

    // Automatic where this copy can replace itself (see update::target), by hand elsewhere.
    fn update_mode(&self) -> tma_ui::UpdateMode {
        match crate::update::target() {
            Some(_) => tma_ui::UpdateMode::Automatic,
            None => tma_ui::UpdateMode::Manual(crate::update::releases_url()),
        }
    }

    fn check_for_update(&mut self, client: &Client, tasks: &Tasks) {
        crate::update::check_now(client.clone(), Notifier::new(tasks));
    }

    fn settings_ui(&mut self, ui: &mut egui::Ui, client: &Client, _tasks: &Tasks) {
        use tma_ui::widgets;
        widgets::heading(
            ui,
            tma_ui::icons::ph::DESKTOP,
            "Desktop app",
            "Settings for the desktop app on this computer.",
        );
        widgets::section(ui, "This computer", "", |ui| {
            tma_ui::widgets::setting_row(ui, "Server", "", |ui| {
                ui.label(client.base_url());
            });
            tma_ui::widgets::setting_row(ui, "Version", "", |ui| {
                ui.label(format!("v{}", env!("CARGO_PKG_VERSION")));
            });
            tma_ui::widgets::setting_row(
                ui,
                "Edit in desktop apps",
                "Open files in installed apps; saved changes upload automatically.",
                |ui| {
                    ui.label("On");
                },
            );
        });
        let note = "Your files in File Explorer and in every app's Open and Save dialogs.";
        widgets::section(ui, "Cloud Drive", note, |ui| {
            let status = self.drive.status();
            let mut restart = false;
            tma_ui::widgets::setting_row(ui, "Status", "", |ui| match &status {
                Status::Mounted(point) => {
                    if tma_ui::widgets::secondary(ui, "Open").clicked() {
                        let _ = open::that_detached(drive_root(point));
                    }
                    ui.label(format!("Connected at {point}"));
                }
                Status::Starting => {
                    ui.spinner();
                }
                Status::Off => {
                    ui.label("Off");
                }
                Status::Failed(err) | Status::Unavailable(err) => {
                    if matches!(status, Status::Failed(_)) && tma_ui::widgets::secondary(ui, "Try again").clicked() {
                        restart = true;
                    }
                    ui.label(err);
                }
            });
            if let (Status::Mounted(_), Some(save_only)) = (&status, self.drive.save_only()) {
                let (mode, note) = if save_only {
                    (
                        "Save-only",
                        "Other apps can browse the drive and save into it, but not open or copy files from it",
                    )
                } else {
                    ("Full access", "Other apps can open and copy files from the drive")
                };
                tma_ui::widgets::setting_row(ui, "Access mode", note, |ui| {
                    ui.label(mode);
                });
                ui.label(widgets::muted(ui, "Set by your administrator.").size(12.0));
            }
            if restart {
                self.drive.start(client, ui.ctx().clone());
            }
        });
    }

    fn header_status(&mut self, ui: &mut egui::Ui) {
        if let Status::Mounted(point) = self.drive.status() {
            let t = tma_ui::widgets::tokens(ui);
            let text = egui::RichText::new(format!("{}  {}", tma_ui::icons::ph::HARD_DRIVES, drive_label(&point)))
                .size(12.0)
                .color(t.positive_text);
            if ui
                .add(egui::Button::new(text).frame(false))
                .on_hover_text("Cloud Drive is connected. Click to open it.")
                .clicked()
            {
                let _ = open::that_detached(drive_root(&point));
            }
        }
    }

    fn edit_in_app(&mut self, client: &Client, file: &FileItem, tasks: &Tasks) -> bool {
        crate::edit::open(self.drive.paths(), client.clone(), file.clone(), Notifier::new(tasks));
        true
    }

    fn clipboard_copy(&mut self, client: &Client, items: &[FileItem], cut: bool, tasks: &Tasks) -> bool {
        crate::clipboard::copied(self.drive.paths(), client.clone(), items.to_vec(), cut, Notifier::new(tasks));
        true
    }

    fn clipboard_has_files(&self) -> bool {
        crate::clipboard::has_files()
    }

    fn clipboard_files(&self) -> Vec<std::path::PathBuf> {
        crate::clipboard::files()
    }

    fn clipboard_contents(&self) -> Vec<tma_client::UploadFile> {
        crate::clipboard::contents()
    }

    fn clipboard_sequence(&self) -> u64 {
        crate::clipboard::sequence()
    }
}
