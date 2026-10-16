//! TMA Cloud's Copy and Cut on the system clipboard, and pasting what other
//! apps copied. Copy downloads the files and folders to a private folder and
//! puts them there as real files, so they paste into Explorer, mail or chat;
//! Cut takes the clipboard over, as in Explorer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tma_client::{Client, ListQuery, Progress, View};
use tma_core::api::FileItem;

use crate::clip_plan;
use crate::notify_ui::Notifier;

/// Larger copies stay in TMA Cloud: downloading them all on Copy would take too long.
const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_COPY_FILES: usize = 10_000;
/// Downloads at once while preparing a copy.
const PARALLEL: usize = 4;
/// Virtual files are written out before the paste; this bounds that wait.
const MAX_VIRTUAL_BYTES: u64 = 500 * 1024 * 1024;
/// Prepared copies older than this are removed; a paste long after is unlikely.
const KEEP_COPIES: std::time::Duration = std::time::Duration::from_secs(24 * 3600);

/// Bumped by every Copy or Cut, so a slow copy finishing late cannot replace a newer one.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The clipboard's sequence number after TMA Cloud last wrote it: those files are ours.
static OWN_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Whether the clipboard holds something to paste as files, per sequence number.
static PASTABLE: Mutex<Option<(u64, bool)>> = Mutex::new(None);

fn label(n: usize) -> String {
    if n == 1 { "1 item".into() } else { format!("{n} items") }
}

fn workspace(kind: &str) -> Option<PathBuf> {
    let root = dirs::cache_dir()?.join("TMA Cloud").join(kind);
    clean_old(&root);
    let dir = root.join(stamp());
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// What a copy downloads: folders to create and files to fetch, by local path.
#[derive(Default)]
struct Plan {
    tops: Vec<PathBuf>,
    dirs: Vec<PathBuf>,
    files: Vec<(String, PathBuf)>,
    bytes: u64,
}

/// List the copied folders on the server, keeping their structure locally.
async fn plan(client: &Client, items: &[FileItem], dir: &Path) -> tma_client::ApiResult<Plan> {
    let mut plan = Plan::default();
    let mut taken = HashSet::new();
    let mut folders = Vec::new();
    for item in items {
        let path = dir.join(clip_plan::unique_name(&tma_core::names::portable_name(&item.name), &mut taken));
        plan.tops.push(path.clone());
        if item.is_folder() {
            folders.push((item.id.clone(), path.clone()));
            plan.dirs.push(path);
        } else {
            plan.bytes += item.size.unwrap_or(0).max(0) as u64;
            plan.files.push((item.id.clone(), path));
        }
    }
    while let Some((id, path)) = folders.pop() {
        let mut taken = HashSet::new();
        let mut query = ListQuery { limit: Some(500), ..Default::default() };
        loop {
            let page = client.list(&View::Folder(Some(id.clone())), &query).await?;
            for child in page.files {
                let name = clip_plan::unique_name(&tma_core::names::portable_name(&child.name), &mut taken);
                let child_path = path.join(name);
                if child.is_folder() {
                    plan.dirs.push(child_path.clone());
                    folders.push((child.id, child_path));
                } else {
                    plan.bytes += child.size.unwrap_or(0).max(0) as u64;
                    plan.files.push((child.id, child_path));
                }
            }
            if plan.bytes > MAX_COPY_BYTES || plan.files.len() > MAX_COPY_FILES {
                return Ok(plan);
            }
            match page.next_cursor {
                Some(cursor) => query.cursor = Some(cursor),
                None => break,
            }
        }
    }
    Ok(plan)
}

/// Fetch every planned file, a few at a time.
async fn download_all(client: &Client, files: Vec<(String, PathBuf)>) -> Result<(), String> {
    let queue = std::sync::Arc::new(Mutex::new(files));
    let mut workers = tokio::task::JoinSet::new();
    for _ in 0..PARALLEL {
        let (client, queue) = (client.clone(), queue.clone());
        workers.spawn(async move {
            loop {
                let next = queue.lock().ok().and_then(|mut q| q.pop());
                let Some((id, path)) = next else { return Ok(()) };
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                client.download_to(&id, &path, Progress::new(0)).await.map_err(|e| format!("{name}: {}", e.message))?;
            }
        });
    }
    while let Some(done) = workers.join_next().await {
        if let Ok(Err(err)) = done {
            workers.abort_all();
            return Err(err);
        }
    }
    Ok(())
}

/// Copy or Cut in TMA Cloud. A paste back into TMA Cloud still copies on the
/// server; the system clipboard is for other apps.
pub fn copied(client: Client, items: Vec<FileItem>, cut: bool, notifier: Notifier) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let total = items.len();
    // Taken at once, as any Ctrl+C does, so an older copy elsewhere cannot be pasted meanwhile.
    claim();
    if cut || items.is_empty() {
        notifier.info(format!("{} cut. Paste to move them.", label(total)));
        return;
    }
    tma_client::rt::spawn(async move {
        let Some(dir) = workspace("clipboard") else {
            notifier.error("Copied in TMA Cloud only: no folder to prepare the files in".to_string());
            return;
        };
        let plan = match plan(&client, &items, &dir).await {
            Ok(plan) => plan,
            Err(err) => {
                notifier.error(format!("Copied in TMA Cloud only: {}", err.message));
                return;
            }
        };
        if plan.bytes > MAX_COPY_BYTES || plan.files.len() > MAX_COPY_FILES {
            notifier.info(format!("{} copied. Over 2 GB, so they paste in TMA Cloud only.", label(total)));
            return;
        }
        if plan.bytes > 20 * 1024 * 1024 {
            notifier.info(format!("Preparing {} for other apps…", tma_core::format::file_size(plan.bytes as i64)));
        }
        for folder in &plan.dirs {
            if let Err(err) = std::fs::create_dir_all(folder) {
                notifier.error(format!("Copied in TMA Cloud only: {err}"));
                return;
            }
        }
        if let Err(err) = download_all(&client, plan.files).await {
            notifier.error(format!("Copied in TMA Cloud, but not for other apps. {err}"));
            return;
        }
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        match set_clipboard(&plan.tops) {
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

fn clean_old(root: &Path) {
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

/// The files to upload for a paste: paths as they are, or other content
/// written to a private folder first.
pub fn files() -> Vec<PathBuf> {
    let listed = file_list();
    if !listed.is_empty() {
        return listed;
    }
    match other_content() {
        Ok(paths) => paths,
        Err(err) => {
            log::warn!("Paste: {err}");
            Vec::new()
        }
    }
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
    let text: String = clipboard_win::get_clipboard_string().unwrap_or_default();
    clip_plan::paths_in_text(&text).into_iter().filter(|p| p.exists()).collect()
}

#[cfg(windows)]
fn other_content() -> Result<Vec<PathBuf>, String> {
    if crate::clipboard_ole::available() {
        let dir = workspace("paste").ok_or("No folder to prepare the pasted files in")?;
        return crate::clipboard_ole::extract(&dir, MAX_VIRTUAL_BYTES);
    }
    if let Some(image) = image_png()? {
        let dir = workspace("paste").ok_or("No folder to prepare the pasted image in")?;
        let name = clip_plan::image_name(&chrono_stamp());
        let path = dir.join(name);
        std::fs::write(&path, image).map_err(|e| e.to_string())?;
        return Ok(vec![path]);
    }
    Ok(text_paths())
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

/// Local time for a pasted image's name: "2026-10-16 183405".
#[cfg(windows)]
fn chrono_stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string()
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
fn pastable_now() -> bool {
    false
}

#[cfg(not(windows))]
fn other_content() -> Result<Vec<PathBuf>, String> {
    Ok(Vec::new())
}

#[cfg(not(windows))]
fn clear_clipboard() -> bool {
    false
}

#[cfg(not(windows))]
fn set_clipboard(paths: &[PathBuf]) -> Result<(), String> {
    // Other systems take file URIs from text; most file managers accept them.
    let uris: Vec<String> = paths.iter().map(|p| format!("file://{}", p.to_string_lossy())).collect();
    Err(format!("Saved to {}. Copy them from there.", uris.join(" ")))
}

#[cfg(not(windows))]
fn file_list() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn sequence() -> u64 {
    0
}
