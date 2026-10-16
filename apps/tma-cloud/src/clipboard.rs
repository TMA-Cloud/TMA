//! Copy cloud files to the system clipboard as real files, so they paste into
//! Explorer, mail or chat. They are downloaded to a private folder first.

use tma_client::{Client, Progress};
use tma_core::api::FileItem;

use crate::notify_ui::Notifier;

pub fn copy_files(client: Client, files: Vec<FileItem>, notifier: Notifier) {
    let files: Vec<FileItem> = files.into_iter().filter(|f| !f.is_folder()).collect();
    if files.is_empty() {
        notifier.info("Only files can be copied to other apps; download folders instead");
        return;
    }
    tma_client::rt::spawn(async move {
        let stamp = chrono_stamp();
        let Some(dir) = dirs::cache_dir().map(|d| d.join("TMA Cloud").join("clipboard").join(stamp)) else { return };
        if let Err(err) = std::fs::create_dir_all(&dir) {
            notifier.error(format!("Cannot prepare the files: {err}"));
            return;
        }
        notifier.info(format!("Preparing {} file(s)…", files.len()));
        let mut paths = Vec::new();
        for file in &files {
            let path = dir.join(tma_core::names::portable_name(&file.name));
            match client.download_to(&file.id, &path, Progress::new(0)).await {
                Ok(()) => paths.push(path),
                Err(err) => {
                    notifier.error(format!("Cannot download {}: {}", file.name, err.message));
                    return;
                }
            }
        }
        match set_clipboard(&paths) {
            Ok(()) => notifier.success(format!("Copied {} file(s). Paste them into any app.", paths.len())),
            Err(err) => notifier.error(err),
        }
    });
}

fn chrono_stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

#[cfg(windows)]
fn set_clipboard(paths: &[std::path::PathBuf]) -> Result<(), String> {
    let list: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let _open = clipboard_win::Clipboard::new_attempts(10).map_err(|e| format!("Cannot use the clipboard: {e}"))?;
    clipboard_win::raw::set_file_list(&list).map_err(|e| format!("Cannot use the clipboard: {e}"))
}

#[cfg(not(windows))]
fn set_clipboard(paths: &[std::path::PathBuf]) -> Result<(), String> {
    // Other systems take file URIs from text; most file managers accept them.
    let uris: Vec<String> = paths.iter().map(|p| format!("file://{}", p.to_string_lossy())).collect();
    Err(format!("Saved to {}. Copy them from there.", uris.join(" ")))
}

/// Whether another app put files on the clipboard; a cheap check, made every frame.
#[cfg(windows)]
pub fn has_files() -> bool {
    clipboard_win::is_format_avail(clipboard_win::formats::CF_HDROP)
}

/// The paths of files copied in Explorer or another app.
#[cfg(windows)]
pub fn files() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(_open) = clipboard_win::Clipboard::new_attempts(10) {
        let _ = clipboard_win::raw::get_file_list_path(&mut out);
    }
    out
}

/// Windows numbers every clipboard write, which tells Paste which copy is newer.
#[cfg(windows)]
pub fn sequence() -> u64 {
    clipboard_win::seq_num().map(|n| u64::from(n.get())).unwrap_or(0)
}

#[cfg(not(windows))]
pub fn has_files() -> bool {
    false
}

#[cfg(not(windows))]
pub fn files() -> Vec<std::path::PathBuf> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn sequence() -> u64 {
    0
}
