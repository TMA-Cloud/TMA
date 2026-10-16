//! TMA Cloud's Copy and Cut on the system clipboard. Copy downloads the files
//! to a private folder and puts them there as real files, so they paste into
//! Explorer, mail or chat; Cut takes the clipboard over, as in Explorer.

use std::sync::atomic::{AtomicU64, Ordering};

use tma_client::{Client, Progress};
use tma_core::api::FileItem;

use crate::notify_ui::Notifier;

/// Larger copies stay in TMA Cloud: downloading them all on Copy would take too long.
const MAX_COPY_BYTES: u64 = 200 * 1024 * 1024;
/// Prepared copies older than this are removed; a paste long after is unlikely.
const KEEP_COPIES: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Bumped by every Copy or Cut, so a slow copy finishing late cannot replace a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The clipboard's sequence number after TMA Cloud last wrote it: those files are ours.
static OWN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn label(n: usize) -> String {
    if n == 1 { "1 item".into() } else { format!("{n} items") }
}

/// Copy or Cut in TMA Cloud. A paste back into TMA Cloud still copies on the
/// server; the system clipboard is for other apps.
pub fn copied(client: Client, items: Vec<FileItem>, cut: bool, notifier: Notifier) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let total = items.len();
    let files: Vec<FileItem> = items.into_iter().filter(|f| !f.is_folder()).collect();
    let bytes: u64 = files.iter().map(|f| f.size.unwrap_or(0).max(0) as u64).sum();
    if cut || files.is_empty() || bytes > MAX_COPY_BYTES {
        claim();
        let note = if cut {
            "Paste to move them".to_string()
        } else if files.is_empty() {
            "Folders paste in TMA Cloud only".to_string()
        } else {
            "Over 200 MB, so they paste in TMA Cloud only".to_string()
        };
        notifier.info(format!("{} {}. {note}.", label(total), if cut { "cut" } else { "copied" }));
        return;
    }
    let folders = total - files.len();
    tma_client::rt::spawn(async move {
        let Some(root) = dirs::cache_dir().map(|d| d.join("TMA Cloud").join("clipboard")) else { return };
        clean_old(&root);
        let dir = root.join(stamp());
        if let Err(err) = std::fs::create_dir_all(&dir) {
            notifier.error(format!("Cannot prepare the files: {err}"));
            return;
        }
        let mut paths = Vec::new();
        for file in &files {
            let path = dir.join(tma_core::names::portable_name(&file.name));
            if let Err(err) = client.download_to(&file.id, &path, Progress::new(0)).await {
                notifier.error(format!(
                    "Copied in TMA Cloud, but {} could not be prepared for other apps: {}",
                    file.name, err.message
                ));
                return;
            }
            paths.push(path);
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        match set_clipboard(&paths) {
            Ok(()) => {
                OWN_SEQUENCE.store(sequence(), Ordering::SeqCst);
                let note = if folders > 0 { " (folders paste in TMA Cloud only)" } else { "" };
                notifier.success(format!("{} copied{note}. Paste here or in any app.", label(total)));
            }
            Err(err) => notifier.error(format!("Copied in TMA Cloud only. {err}")),
        }
    });
}

/// Empty the system clipboard, so an older copy from another app cannot be pasted instead.
fn claim() {
    if clear_clipboard() {
        OWN_SEQUENCE.store(sequence(), Ordering::SeqCst);
    }
}

fn clean_old(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|m| m.elapsed().ok());
        if old.is_some_and(|age| age > KEEP_COPIES) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn stamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

/// Whether files another app copied are on the clipboard (not TMA Cloud's own).
pub fn has_files() -> bool {
    has_file_list() && sequence() != OWN_SEQUENCE.load(Ordering::SeqCst)
}

#[cfg(windows)]
fn clear_clipboard() -> bool {
    clipboard_win::Clipboard::new_attempts(10).is_ok_and(|_open| clipboard_win::raw::empty().is_ok())
}

#[cfg(not(windows))]
fn clear_clipboard() -> bool {
    false
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

/// Whether files are on the clipboard; a cheap check, made every frame.
#[cfg(windows)]
fn has_file_list() -> bool {
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
fn has_file_list() -> bool {
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
