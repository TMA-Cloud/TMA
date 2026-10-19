//! The Windows adapter: the Cloud Files API that OneDrive uses, built into
//! Windows 10 and later, so Cloud Drive needs no driver. The drive is a folder
//! of placeholders that download when opened and upload when changed.

mod cfapi;
mod editing;
mod feed;
mod filter;
mod local;
mod worker;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use cloud_filter::root::{
    Connection, HydrationType, PopulationType, ProtectionMode, SecurityId, Session, SupportedAttribute, SyncRootId,
    SyncRootIdBuilder, SyncRootInfo,
};
use notify::Watcher;

use crate::core::Core;
use filter::Filter;
use worker::Shared;

const PROVIDER: &str = "TMACloud";

/// Cloud Files arrived in Windows 10 1709.
pub fn is_available() -> bool {
    cloud_filter::root::is_supported().unwrap_or(false)
}

/// The folder the drive appears as: "TMA Cloud" in the user's profile, like OneDrive.
pub fn default_mount_point() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("TMA Cloud"))
}

/// A connected drive folder; dropping it stops syncing (the folder and its
/// downloaded files stay, as with OneDrive).
pub struct Mounted {
    pub mount_point: String,
    pub core: Arc<Core>,
    shared: Arc<Shared>,
    worker: Option<std::thread::JoinHandle<()>>,
    watcher: Option<notify::RecommendedWatcher>,
    connection: Option<Connection<Filter>>,
}

impl Drop for Mounted {
    fn drop(&mut self) {
        self.watcher.take();
        self.shared.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        self.connection.take();
    }
}

impl Mounted {
    /// Stop syncing and unregister the folder, removing its synced copies
    /// (anything not uploaded yet stays).
    pub fn forget(self) -> Result<(), String> {
        let folder = PathBuf::from(&self.mount_point);
        drop(self);
        unregister(Some(&folder), None)?;
        let _ = std::fs::remove_dir(&folder);
        Ok(())
    }
}

/// Unregister every drive folder of this app for the signed-in Windows user,
/// as the uninstaller does. Synced copies go; anything not uploaded yet stays,
/// and so does a folder that still holds it. Run it with the app closed.
pub fn forget_all() -> Result<(), String> {
    for folder in unregister(None, None)? {
        let _ = std::fs::remove_dir(&folder);
    }
    Ok(())
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().trim_end_matches('\\').eq_ignore_ascii_case(b.to_string_lossy().trim_end_matches('\\'))
}

/// Remove a folder's synced copies, keeping anything made or changed locally.
fn clear(folder: &Path) -> Result<(), String> {
    // A running app would take these deletes as the user's and trash the files on the server.
    let idle = Session::new()
        .connect(folder, filter::Idle)
        .map_err(|e| format!("Close TMA Cloud before removing its folder ({e})"))?;
    if let Ok(items) = std::fs::read_dir(folder) {
        for item in items.flatten() {
            local::remove_synced(&item.path());
        }
    }
    drop(idle);
    Ok(())
}

/// Unregister this provider's sync roots at `folder` (all of them for `None`),
/// except `keep`, removing their synced copies. Returns the folders unregistered.
fn unregister(folder: Option<&Path>, keep: Option<&SyncRootId>) -> Result<Vec<PathBuf>, String> {
    let roots = cloud_filter::root::active_roots().map_err(|e| e.to_string())?;
    let mut released = Vec::new();
    for root in roots {
        let id = root.id();
        let path = root.path();
        // Other providers' ids need not split cleanly; compare the prefix only.
        let ours = id.to_os_string().to_string_lossy().starts_with(&format!("{PROVIDER}!"));
        let here = folder.is_none_or(|f| same_path(&path, f));
        if !ours || !here || keep.is_some_and(|k| id.to_os_string() == k.to_os_string()) {
            continue;
        }
        clear(&path)?;
        id.unregister().map_err(|e| format!("Cannot release the drive folder: {e}"))?;
        released.push(path);
    }
    Ok(released)
}

/// Whether anything other than synced copies is in a folder.
fn holds_local_work(folder: &Path) -> bool {
    std::fs::read_dir(folder).is_ok_and(|mut items| items.next().is_some())
}

/// A folder left by another account (or an older registration) is never
/// reused: its synced placeholders go, and anything made there is set aside.
fn release_folder(folder: &Path, keep: &SyncRootId) -> Result<(), String> {
    if !unregister(Some(folder), Some(keep))?.is_empty() && holds_local_work(folder) {
        let aside = folder.with_file_name(format!(
            "{} (previous account {})",
            folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            chrono::Local::now().format("%Y-%m-%d %H%M")
        ));
        std::fs::rename(folder, &aside).map_err(|e| format!("Cannot move the old drive folder aside: {e}"))?;
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn register(id: &SyncRootId, folder: &Path, label: &str) -> Result<(), String> {
    if id.is_registered().unwrap_or(false) {
        match id.info() {
            Ok(info) if same_path(&info.path(), folder) => return Ok(()),
            _ => id.unregister().map_err(|e| e.to_string())?,
        }
    }
    let icon = std::env::current_exe().map(|exe| format!("{},0", exe.display())).unwrap_or_default();
    let info = SyncRootInfo::default()
        .with_display_name(label)
        .with_icon(icon)
        .with_version(env!("CARGO_PKG_VERSION"))
        .with_hydration_type(HydrationType::Full)
        .with_population_type(PopulationType::Full)
        .with_protection_mode(ProtectionMode::Personal)
        .with_allow_pinning(true)
        .with_supported_attribute(SupportedAttribute::FileLastWriteTime | SupportedAttribute::DirectoryLastWriteTime)
        .with_path(folder)
        .map_err(|e| e.to_string())?;
    id.register(info).map_err(|e| format!("Cannot register the drive folder: {e}"))
}

pub fn mount(core: Arc<Core>, label: &str, at: Option<&str>) -> Result<Mounted, String> {
    if !is_available() {
        return Err("This version of Windows has no Cloud Files support".into());
    }
    let folder = match at {
        Some(path) => PathBuf::from(path),
        None => default_mount_point().ok_or("No profile folder to put TMA Cloud in")?,
    };
    std::fs::create_dir_all(&folder).map_err(|e| format!("Cannot create {}: {e}", folder.display()))?;
    let account = core.backend().account().ok().filter(|a| !a.is_empty()).unwrap_or_else(|| "default".into());
    let sid = SecurityId::current_user().map_err(|e| e.to_string())?;
    let id = SyncRootIdBuilder::new(PROVIDER).user_security_id(sid).account_name(account).build();
    release_folder(&folder, &id)?;
    register(&id, &folder, label)?;

    core.follow_changes();
    let shared = Arc::new(Shared::new(core.clone(), folder.clone()));
    let connection = Session::new()
        .connect(&folder, Filter { shared: shared.clone() })
        .map_err(|e| format!("Cannot connect the drive folder: {e}"))?;
    let events = shared.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        for path in event.paths {
            if path.is_dir() {
                events.changed(path.clone());
            }
            if let Some(parent) = path.parent() {
                events.changed(parent.to_path_buf());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&folder, notify::RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    // Windows never asks for the sync root's own contents, so list it before showing it.
    shared.resync_folder(&folder);
    if let Err(err) = local::mark_listed(&folder) {
        log::warn!("Cloud Drive root stays unlisted: {err}");
    }
    let runner = shared.clone();
    let worker = std::thread::Builder::new()
        .name("cloud-drive-sync".into())
        .spawn(move || runner.run())
        .map_err(|e| e.to_string())?;
    Ok(Mounted {
        mount_point: folder.display().to_string(),
        core,
        shared,
        worker: Some(worker),
        watcher: Some(watcher),
        connection: Some(connection),
    })
}
