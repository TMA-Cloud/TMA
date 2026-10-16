//! Cloud Drive in the desktop app: mounts after sign-in, unmounts on sign-out,
//! follows the server's save-only setting and drops cached listings when files
//! change elsewhere.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tma_client::Client;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    Off,
    Starting,
    Mounted(String),
    Failed(String),
    /// The OS piece (FUSE on Linux, a recent Windows) is missing.
    Unavailable(String),
}

#[derive(Default)]
pub struct Drive {
    status: Arc<Mutex<Status>>,
    stop: Option<std::sync::mpsc::Sender<()>>,
}

fn set(status: &Arc<Mutex<Status>>, value: Status) {
    *status.lock().unwrap_or_else(|e| e.into_inner()) = value;
}

impl Drive {
    pub fn status(&self) -> Status {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn start(&mut self, client: &Client, ctx: egui::Context) {
        self.stop();
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        self.stop = Some(tx);
        let status = self.status.clone();
        set(&status, Status::Starting);
        let client = client.clone();
        let spawned = std::thread::Builder::new().name("cloud-drive".into()).spawn(move || {
            run(client, &status, &rx);
            ctx.request_repaint();
        });
        if let Err(err) = spawned {
            set(&self.status, Status::Failed(err.to_string()));
        }
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        set(&self.status, Status::Off);
    }
}

/// A mounted drive of whichever adapter this system uses; dropping it unmounts.
type Guard = Box<dyn std::any::Any>;

/// Windows: a Cloud Files folder (built in since Windows 10 1709), or a WinFsp
/// drive letter where Cloud Files is missing and WinFsp is installed.
#[cfg(windows)]
fn mount(core: Arc<tma_drive::Core>) -> Result<(String, Guard), Status> {
    if tma_drive::is_available() {
        let m = tma_drive::mount(core, "TMA Cloud", None).map_err(Status::Failed)?;
        return Ok((m.mount_point.clone(), Box::new(m)));
    }
    if tma_drive::winfsp_fs::is_available() {
        let m = tma_drive::winfsp_fs::mount(core, "TMA Cloud", None).map_err(Status::Failed)?;
        return Ok((m.mount_point.clone(), Box::new(m)));
    }
    Err(Status::Unavailable("Cloud Drive needs Windows 10 version 1709 or later.".into()))
}

/// macOS mounts a local NFS share with its built-in client; Linux uses FUSE.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn mount(core: Arc<tma_drive::Core>) -> Result<(String, Guard), Status> {
    if !tma_drive::is_available() {
        let hint = if cfg!(target_os = "macos") {
            "Cloud Drive needs the system NFS client."
        } else {
            "Install FUSE (the fuse3 package) to use Cloud Drive."
        };
        return Err(Status::Unavailable(hint.into()));
    }
    let m = tma_drive::mount(core, "TMA Cloud", None).map_err(Status::Failed)?;
    Ok((m.mount_point.clone(), Box::new(m)))
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
fn run(client: Client, status: &Arc<Mutex<Status>>, rx: &std::sync::mpsc::Receiver<()>) {
    let staging = std::env::temp_dir().join("tma-cloud-fs");
    let backend: Arc<dyn tma_drive::Backend> = Arc::new(tma_drive::ClientBackend::new(client.clone()));
    // Windows refuses some characters in names; they map to look-alikes and back.
    let core = match tma_drive::Core::new(backend.clone(), staging, cfg!(windows)) {
        Ok(core) => Arc::new(core),
        Err(err) => {
            set(status, Status::Failed(err.to_string()));
            return;
        }
    };
    // Until the server answers, the drive stays save-only: the safer of the two modes.
    core.deny_read.store(backend.save_only().unwrap_or(true), Ordering::Relaxed);
    let (point, mounted) = match mount(core.clone()) {
        Ok(m) => m,
        Err(err) => {
            set(status, err);
            return;
        }
    };
    log::info!("Cloud Drive mounted at {point}");
    set(status, Status::Mounted(point));
    let events_core = core.clone();
    // A change made anywhere (web, another device) shows up in the drive at once.
    let _events = tma_client::events::subscribe(&client, Arc::new(move |_| events_core.invalidate_all()));
    let polling = Arc::new(AtomicBool::new(true));
    let (poll_core, poll_flag) = (core.clone(), polling.clone());
    let _ = std::thread::Builder::new().name("drive-mode".into()).spawn(move || {
        while poll_flag.load(Ordering::Relaxed) {
            for _ in 0..60 {
                if !poll_flag.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
            if let Ok(save_only) = poll_core.backend().save_only() {
                poll_core.deny_read.store(save_only, Ordering::Relaxed);
            }
        }
    });
    let _ = rx.recv();
    polling.store(false, Ordering::Relaxed);
    drop(mounted);
    log::info!("Cloud Drive unmounted");
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn run(_client: Client, status: &Arc<Mutex<Status>>, _rx: &std::sync::mpsc::Receiver<()>) {
    set(status, Status::Unavailable("Cloud Drive is not available on this system.".into()));
}
