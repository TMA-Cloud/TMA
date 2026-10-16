//! What the app shell provides: the web page and the desktop app differ in
//! how sessions persist, how links open and which extras exist (Cloud Drive,
//! editing in a desktop app, app updates).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tma_client::Client;
use tma_core::api::{FileItem, User};

use crate::tasks::Tasks;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    Web,
    Desktop,
}

/// A remembered sign-in on desktop: the server and its session cookie.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SavedSession {
    pub server: String,
    pub token: Option<String>,
}

pub trait Host {
    fn kind(&self) -> HostKind;

    /// This app's version, shown in Settings > Updates.
    fn app_version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    /// The last server and session (desktop only).
    fn saved_session(&self) -> Option<SavedSession> {
        None
    }

    fn save_session(&mut self, _session: Option<&SavedSession>) {}

    fn open_url(&self, url: &str);

    /// After sign-in: start the extras (Cloud Drive, presence, update checks).
    fn signed_in(&mut self, _client: &Client, _user: &User, _tasks: &Tasks) {}

    fn signed_out(&mut self) {}

    /// The extra Settings section's title, when the host has one.
    fn settings_title(&self) -> Option<&'static str> {
        None
    }

    fn settings_ui(&mut self, _ui: &mut egui::Ui, _client: &Client, _tasks: &Tasks) {}

    /// Open a file in its desktop app and upload saves back; `false` when unavailable.
    fn edit_in_app(&mut self, _client: &Client, _file: &FileItem, _tasks: &Tasks) -> bool {
        false
    }

    /// Copy or Cut in TMA Cloud: mirror it on the system clipboard for other apps
    /// (desktop only). `true` when the host also told the user.
    fn clipboard_copy(&mut self, _client: &Client, _items: &[FileItem], _cut: bool, _tasks: &Tasks) -> bool {
        false
    }

    /// Whether another app put files on the system clipboard (cheap; asked every frame).
    fn clipboard_has_files(&self) -> bool {
        false
    }

    /// The files another app put on the system clipboard (Explorer's Copy), as local paths.
    fn clipboard_files(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }

    /// Changes whenever any app writes the system clipboard, so Paste can tell which copy is newer.
    fn clipboard_sequence(&self) -> u64 {
        0
    }

    /// A small status element in the header (the Cloud Drive light).
    fn header_status(&mut self, _ui: &mut egui::Ui) {}

    /// Called every frame, for hosts that poll background state.
    fn tick(&mut self, _ctx: &egui::Context, _tasks: &Tasks) {}
}

/// Active Sessions shows a tab as online while its last heartbeat is under three minutes old.
const PRESENCE_EVERY: std::time::Duration = std::time::Duration::from_secs(120);

/// The web page: the browser keeps the session cookie and opens links.
#[derive(Default)]
pub struct WebHost {
    presence_stop: Option<Arc<AtomicBool>>,
}

impl Host for WebHost {
    fn kind(&self) -> HostKind {
        HostKind::Web
    }

    fn open_url(&self, url: &str) {
        crate::platform::open_url(url);
    }

    fn signed_in(&mut self, client: &Client, _user: &User, _tasks: &Tasks) {
        self.signed_out();
        let stop = Arc::new(AtomicBool::new(false));
        self.presence_stop = Some(stop.clone());
        let client = client.clone();
        tma_client::rt::spawn(async move {
            while !stop.load(Ordering::Relaxed) {
                if let Err(err) = client.session_heartbeat().await {
                    log::debug!("Session heartbeat failed: {err}");
                }
                tma_client::rt::sleep(PRESENCE_EVERY).await;
            }
        });
    }

    fn signed_out(&mut self) {
        if let Some(stop) = self.presence_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}
