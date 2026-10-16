//! Edit in a desktop app: download to a private folder, open it with the
//! system's app for its type, and upload every save back. A "Save As" PDF or
//! copy in the same folder is uploaded next to the original.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use tma_client::{Client, Progress, UploadFile};
use tma_core::api::FileItem;

use crate::notify_ui::Notifier;

const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Formats an editor's Save As commonly produces; anything else in the folder is ignored.
const DERIVED_EXTS: &[&str] = &[
    "pdf", "docx", "doc", "docm", "rtf", "odt", "txt", "html", "mht", "xlsx", "xls", "xlsm", "csv", "pptx", "ppt",
    "pptm", "odp",
];

/// Programs and scripts are never opened from the cloud.
const BLOCKED_EXTS: &[&str] = &[
    "exe", "dll", "bat", "cmd", "com", "pif", "scr", "vbs", "js", "jse", "ws", "wsf", "wsh", "ps1", "psm1", "msi",
    "msp", "jar", "lnk", "reg", "hta", "cpl", "sh", "app", "command",
];

struct Session {
    _watcher: notify::RecommendedWatcher,
}

/// Open edit sessions, kept until the app quits.
#[derive(Default, Clone)]
pub struct Edits {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

/// File names that Windows and other systems accept, keeping the extension.
fn safe_name(name: &str) -> String {
    let cleaned: String =
        name.chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() { "file".into() } else { trimmed }
}

fn content_hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
}

fn upload_source(path: &Path) -> Option<UploadFile> {
    let meta = std::fs::metadata(path).ok()?;
    let modified_ms =
        meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Some(UploadFile {
        name: path.file_name()?.to_string_lossy().to_string(),
        size: meta.len(),
        source: tma_client::Source::Path(path.to_path_buf()),
        modified_ms,
        relative_dir: None,
    })
}

impl Edits {
    pub fn open(&self, client: Client, file: FileItem, notifier: Notifier) {
        let ext = tma_core::names::extension_of(&file.name);
        if BLOCKED_EXTS.contains(&ext.as_str()) {
            notifier.error("Programs and scripts can't be opened from the cloud. Download the file to run it.");
            return;
        }
        let edits = self.clone();
        tma_client::rt::spawn(async move {
            let Some(dir) = dirs::cache_dir().map(|d| d.join("TMA Cloud").join("edit").join(&file.id)) else {
                notifier.error("No folder to keep the file in while you edit it");
                return;
            };
            let path = dir.join(safe_name(&file.name));
            // Already open and watched: its saves upload, so the local copy is current.
            let watched = edits.sessions.lock().map(|s| s.contains_key(&file.id)).unwrap_or(false);
            if watched && path.exists() {
                launch(&path, &file.name, &notifier);
                return;
            }
            if let Err(err) = std::fs::create_dir_all(&dir) {
                notifier.error(format!("Cannot prepare the file: {err}"));
                return;
            }
            let progress = notifier.track_download(&file.name);
            if let Err(err) = client.download_to(&file.id, &path, progress.clone()).await {
                notifier.finish_download(&progress, Some(err.message.clone()));
                notifier.error(format!("Cannot download {}: {}", file.name, err.message));
                return;
            }
            notifier.finish_download(&progress, None);
            if !launch(&path, &file.name, &notifier) {
                return;
            }
            match watch(client, file.clone(), dir, path, notifier.clone()) {
                Ok(watcher) => {
                    if let Ok(mut sessions) = edits.sessions.lock() {
                        sessions.insert(file.id.clone(), Session { _watcher: watcher });
                    }
                }
                Err(err) => notifier.error(format!("Saves will not upload automatically: {err}")),
            }
        });
    }
}

/// Open a file in its app; Windows asks which app when none is set for the type.
fn launch(path: &Path, name: &str, notifier: &Notifier) -> bool {
    if open::that_detached(path).is_ok() {
        return true;
    }
    #[cfg(windows)]
    {
        let chooser = std::process::Command::new("rundll32.exe").arg("shell32.dll,OpenAs_RunDLL").arg(path).spawn();
        if chooser.is_ok() {
            return true;
        }
    }
    notifier.error(format!("No app opens {name}"));
    false
}

/// Watch the edit folder: saves of the file replace it, Save As copies upload beside it.
fn watch(
    client: Client,
    file: FileItem,
    dir: PathBuf,
    main_path: PathBuf,
    notifier: Notifier,
) -> notify::Result<notify::RecommendedWatcher> {
    let (tx, rx) = std::sync::mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event
            && (event.kind.is_modify() || event.kind.is_create())
        {
            for path in event.paths {
                let _ = tx.send(path);
            }
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    let handle = tma_client::rt::handle();
    std::thread::Builder::new()
        .name(format!("edit-{}", file.id))
        .spawn(move || {
            let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
            let mut last_hash = content_hash(&main_path);
            let mut uploaded_derived: HashMap<PathBuf, u64> = HashMap::new();
            loop {
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(path) => {
                        pending.insert(path, Instant::now());
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
                let ready: Vec<PathBuf> =
                    pending.iter().filter(|(_, at)| at.elapsed() >= DEBOUNCE).map(|(p, _)| p.clone()).collect();
                for path in ready {
                    pending.remove(&path);
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    // Office keeps "~$name" lock files and temporary copies beside the document.
                    if name.starts_with("~$") || name.ends_with(".tmp") || name.ends_with(".part") || !path.is_file() {
                        continue;
                    }
                    let Some(hash) = content_hash(&path) else { continue };
                    let Some(upload) = upload_source(&path) else { continue };
                    if path == main_path {
                        if last_hash == Some(hash) {
                            continue;
                        }
                        last_hash = Some(hash);
                        match handle.block_on(client.replace(&file.id, &upload, Progress::new(upload.size))) {
                            Ok(_) => notifier.success(format!("Saved {} to the cloud", file.name)),
                            Err(err) => notifier.error(format!("Could not save {}: {}", file.name, err.message)),
                        }
                    } else if DERIVED_EXTS.contains(&tma_core::names::extension_of(&name).as_str()) {
                        if uploaded_derived.get(&path) == Some(&hash) {
                            continue;
                        }
                        uploaded_derived.insert(path.clone(), hash);
                        match handle.block_on(client.upload_derived(&file.id, &upload, Progress::new(upload.size))) {
                            Ok(item) => notifier.success(format!("Uploaded {} next to {}", item.name, file.name)),
                            Err(err) => notifier.error(format!("Could not upload {name}: {}", err.message)),
                        }
                    }
                }
            }
        })
        .map_err(|e| notify::Error::generic(&e.to_string()))?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("a:b?.docx"), "a_b_.docx");
        assert_eq!(safe_name("..."), "file");
    }
}
