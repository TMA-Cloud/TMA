//! TMA Cloud's Copy and Cut on the system clipboard, and pasting what other
//! apps copied. Copy puts the items' paths in the Cloud Drive folder on the
//! clipboard, so Explorer, mail or chat paste the real files and Windows
//! downloads them only then; nothing is copied anywhere first. Cut takes the
//! clipboard over, as in Explorer.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tma_client::{Client, Source, UploadFile};
use tma_core::api::FileItem;

use crate::clip_plan;
use crate::drive::Paths;
use crate::notify_ui::Notifier;

/// How long copied items stay readable in save-only mode: a paste is usually soon.
const PASTE_WINDOW: Duration = Duration::from_secs(24 * 3600);
/// Virtual files and images are read into memory before they upload; this bounds that.
const MAX_IN_MEMORY: u64 = 500 * 1024 * 1024;

/// Bumped by every Copy or Cut, so a slow copy finishing late cannot replace a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The clipboard's sequence number after TMA Cloud last wrote it: those files are ours.
static OWN_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Whether the clipboard holds something to paste as files, per sequence number.
static PASTABLE: Mutex<Option<(u64, bool)>> = Mutex::new(None);

fn label(n: usize) -> String {
    if n == 1 { "1 item".into() } else { format!("{n} items") }
}

/// Copy or Cut in TMA Cloud. A paste back into TMA Cloud still copies on the
/// server; the system clipboard is for other apps.
pub fn copied(paths: Paths, client: Client, items: Vec<FileItem>, cut: bool, notifier: Notifier) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let total = items.len();
    // Taken at once, as any Ctrl+C does, so an older copy elsewhere cannot be pasted meanwhile.
    claim();
    if cut || items.is_empty() {
        notifier.info(format!("{} cut. Paste to move them.", label(total)));
        return;
    }
    tma_client::rt::spawn(async move {
        let mut local = Vec::new();
        for item in &items {
            let info = match client.info(&item.id).await {
                Ok(info) => info,
                Err(err) => {
                    notifier.error(format!("Copied in TMA Cloud only: {}", err.message));
                    return;
                }
            };
            match paths.local_path(&info.location_path, &info.name, PASTE_WINDOW) {
                Some(path) => local.push(path),
                None => {
                    notifier
                        .info(format!("{} copied. Connect Cloud Drive to paste in other apps as well.", label(total)));
                    return;
                }
            }
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        match set_clipboard(&local) {
            Ok(()) => {
                OWN_SEQUENCE.store(sequence(), Ordering::SeqCst);
                notifier.success(format!("{} copied. Paste here or in any app.", label(total)));
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

/// Whether another app copied something that pastes as files: files and
/// folders, virtual files, an image, or file paths as text. Checked every
/// frame, so the answer is kept per clipboard change.
pub fn has_files() -> bool {
    let seq = sequence();
    if seq == OWN_SEQUENCE.load(Ordering::SeqCst) {
        return false;
    }
    let Ok(mut cached) = PASTABLE.lock() else { return false };
    match *cached {
        Some((at, answer)) if at == seq => answer,
        _ => {
            let answer = pastable_now();
            *cached = Some((seq, answer));
            answer
        }
    }
}

/// Files and folders another app copied, as paths (Explorer's Copy, or paths as text).
pub fn files() -> Vec<PathBuf> {
    let listed = file_list();
    if !listed.is_empty() { listed } else { text_paths() }
}

/// What exists only in memory: virtual files (Outlook, zip folders) or a copied image.
pub fn contents() -> Vec<UploadFile> {
    match in_memory() {
        Ok(files) => files,
        Err(err) => {
            log::warn!("Paste: {err}");
            Vec::new()
        }
    }
}

/// An upload straight from memory; `path` is where it sits inside the copy.
fn bytes_upload(path: &std::path::Path, bytes: Vec<u8>) -> Option<UploadFile> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let dir = path.parent().map(|p| p.to_string_lossy().replace('\\', "/")).filter(|d| !d.is_empty());
    Some(UploadFile {
        name,
        size: bytes.len() as u64,
        source: Source::Bytes(bytes.into()),
        modified_ms: None,
        relative_dir: dir,
    })
}

#[cfg(windows)]
fn in_memory() -> Result<Vec<UploadFile>, String> {
    if crate::clipboard_ole::available() {
        let files = crate::clipboard_ole::read_all(MAX_IN_MEMORY)?;
        return Ok(files.into_iter().filter_map(|(path, bytes)| bytes_upload(&path, bytes)).collect());
    }
    let name = clip_plan::image_name(&chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string());
    Ok(image_png()?.and_then(|png| bytes_upload(std::path::Path::new(&name), png)).into_iter().collect())
}

#[cfg(windows)]
fn pastable_now() -> bool {
    use clipboard_win::formats::{CF_DIB, CF_HDROP, CF_UNICODETEXT};
    if clipboard_win::is_format_avail(CF_HDROP) || crate::clipboard_ole::available() {
        return true;
    }
    let text = clipboard_win::is_format_avail(CF_UNICODETEXT);
    // Office copies text with a picture of it; only a bare image pastes as one.
    if !text && (clipboard_win::is_format_avail(CF_DIB) || png_format().is_some_and(clipboard_win::is_format_avail)) {
        return true;
    }
    text && !text_paths().is_empty()
}

#[cfg(windows)]
fn png_format() -> Option<u32> {
    clipboard_win::register_format("PNG").map(|f| f.get())
}

#[cfg(windows)]
fn text_paths() -> Vec<PathBuf> {
    if !clipboard_win::is_format_avail(clipboard_win::formats::CF_UNICODETEXT) {
        return Vec::new();
    }
    let text: String = clipboard_win::get_clipboard_string().unwrap_or_default();
    clip_plan::paths_in_text(&text).into_iter().filter(|p| p.exists()).collect()
}

/// A bare copied image as PNG bytes: the app's own PNG when it gave one, else the bitmap converted.
#[cfg(windows)]
fn image_png() -> Result<Option<Vec<u8>>, String> {
    use clipboard_win::formats::{CF_DIB, CF_UNICODETEXT};
    if clipboard_win::is_format_avail(CF_UNICODETEXT) {
        return Ok(None);
    }
    let _open = clipboard_win::Clipboard::new_attempts(10).map_err(|e| format!("Cannot use the clipboard: {e}"))?;
    if let Some(png) = png_format().filter(|f| clipboard_win::is_format_avail(*f)) {
        let mut out = Vec::new();
        if clipboard_win::raw::get_vec(png, &mut out).is_ok() && !out.is_empty() {
            return Ok(Some(out));
        }
    }
    if !clipboard_win::is_format_avail(CF_DIB) {
        return Ok(None);
    }
    let mut bmp = Vec::new();
    clipboard_win::raw::get_bitmap(&mut bmp).map_err(|e| format!("Cannot read the copied image: {e}"))?;
    let image = image::load_from_memory(&bmp).map_err(|e| format!("Cannot read the copied image: {e}"))?;
    let mut png = std::io::Cursor::new(Vec::new());
    image.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(Some(png.into_inner()))
}

#[cfg(windows)]
fn clear_clipboard() -> bool {
    clipboard_win::Clipboard::new_attempts(10).is_ok_and(|_open| clipboard_win::raw::empty().is_ok())
}

#[cfg(windows)]
fn set_clipboard(paths: &[PathBuf]) -> Result<(), String> {
    let list: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let _open = clipboard_win::Clipboard::new_attempts(10).map_err(|e| format!("Cannot use the clipboard: {e}"))?;
    clipboard_win::raw::set_file_list(&list).map_err(|e| format!("Cannot use the clipboard: {e}"))
}

/// The paths of files and folders copied in Explorer or another app.
#[cfg(windows)]
fn file_list() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if clipboard_win::is_format_avail(clipboard_win::formats::CF_HDROP)
        && let Ok(_open) = clipboard_win::Clipboard::new_attempts(10)
    {
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
fn in_memory() -> Result<Vec<UploadFile>, String> {
    let _ = (MAX_IN_MEMORY, bytes_upload as fn(&std::path::Path, Vec<u8>) -> Option<UploadFile>);
    Ok(Vec::new())
}

#[cfg(not(windows))]
fn pastable_now() -> bool {
    false
}

#[cfg(not(windows))]
fn text_paths() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(not(windows))]
fn clear_clipboard() -> bool {
    false
}

#[cfg(not(windows))]
fn set_clipboard(paths: &[PathBuf]) -> Result<(), String> {
    // Other systems take file URIs from text; most file managers accept them.
    let uris: Vec<String> = paths.iter().map(|p| format!("file://{}", p.to_string_lossy())).collect();
    Err(format!("The files are in Cloud Drive at {}.", uris.join(" ")))
}

#[cfg(not(windows))]
fn file_list() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn sequence() -> u64 {
    0
}
