//! The local side of the sync root: reading folders without downloading
//! anything, and creating or updating placeholders.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use cloud_filter::metadata::Metadata;
use cloud_filter::placeholder::{ConvertOptions, Placeholder, UpdateOptions};
use cloud_filter::placeholder_file::PlaceholderFile;
use cloud_filter::utility::FileTime;

use crate::backend::Entry;
use crate::cloud_files::cfapi;
use crate::core::Node;
use crate::sync_plan::{Local, Stamp};

/// 100 ns ticks between 1601 (Windows) and 1970 (Unix).
const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

pub fn file_time(at: DateTime<Utc>) -> FileTime {
    FileTime::new((at.timestamp_millis() + EPOCH_DIFF_MS).max(0) as u64 * 10_000)
}

/// A listing node as a planner entry; the root and local-only nodes have no id.
pub fn entry(node: &Node) -> Option<Entry> {
    Some(Entry {
        id: node.id.clone()?,
        name: node.name.clone(),
        is_folder: node.is_folder,
        size: node.size,
        modified: node.modified,
        accessed: node.accessed,
        version: node.version,
    })
}

fn metadata(entry: &Entry) -> Metadata {
    let at = file_time(entry.modified);
    let base = if entry.is_folder { Metadata::directory() } else { Metadata::file().size(entry.size) };
    base.created(at).written(at).changed(at).accessed(entry.accessed.map(file_time).unwrap_or(at))
}

/// A placeholder for a server item: no contents until opened, folders listed when browsed.
pub fn placeholder(entry: &Entry) -> PlaceholderFile {
    PlaceholderFile::new(&entry.name).metadata(metadata(entry)).blob(Stamp::of(entry).encode()).mark_in_sync()
}

pub fn create(dir: &Path, entry: &Entry) -> std::io::Result<()> {
    placeholder(entry).create::<&Path>(dir).map(|_| ()).map_err(std::io::Error::other)
}

/// What a placeholder knows: its stamp, whether it still matches the server,
/// and (for a folder) whether its contents are on disk.
fn inspect(path: &Path) -> std::io::Result<Option<(Option<Stamp>, bool, bool)>> {
    let state = cfapi::state(path)?;
    Ok(state.map(|s| (Stamp::decode(&s.identity), s.in_sync, !s.partial)))
}

pub struct Folder {
    pub items: Vec<Local>,
    /// Items another app has open; left alone until it lets go.
    pub busy: Vec<String>,
    /// Subfolders whose contents are on disk.
    pub populated: Vec<PathBuf>,
}

/// A local folder's items, read without downloading or listing anything new.
pub fn read(dir: &Path) -> std::io::Result<Folder> {
    let mut folder = Folder { items: Vec::new(), busy: Vec::new(), populated: Vec::new() };
    for item in std::fs::read_dir(dir)?.flatten() {
        let Ok(name) = item.file_name().into_string() else { continue };
        let Ok(meta) = item.metadata() else { continue };
        let is_dir = meta.is_dir();
        let path = item.path();
        match inspect(&path) {
            Ok(state) => {
                // A plain folder made here is always on disk.
                let (stamp, in_sync, populated) = state.unwrap_or((None, false, true));
                if is_dir && populated {
                    folder.populated.push(path);
                }
                folder.items.push(Local { name, is_dir, stamp, in_sync });
            }
            Err(_) => folder.busy.push(name),
        }
    }
    Ok(folder)
}

/// Make a file or folder made here a placeholder for its new server copy.
pub fn adopt(path: &Path, stamp: &Stamp) -> std::io::Result<()> {
    let mut placeholder =
        Placeholder::options().write_access().exclusive().open(path).map_err(std::io::Error::other)?;
    let blob = stamp.encode();
    let converted =
        placeholder.convert_to_placeholder(ConvertOptions::default().mark_in_sync().blob(blob.clone()), None);
    if converted.is_err() {
        // Already a placeholder (an earlier attempt converted it): just restamp it.
        placeholder.update(UpdateOptions::default().blob(&blob).mark_in_sync(), None).map_err(std::io::Error::other)?;
    }
    Ok(())
}

/// Mark a folder the engine filled itself as listed, so it opens while the app is closed.
pub fn mark_listed(path: &Path) -> std::io::Result<()> {
    Placeholder::options()
        .write_access()
        .open(path)
        .and_then(|mut p| p.update(UpdateOptions::default().has_no_children(), None).map(|_| ()))
        .map_err(std::io::Error::other)
}

/// Point a placeholder at a newer server copy and drop the stale local contents.
pub fn refresh(path: &Path, entry: &Entry) -> std::io::Result<()> {
    let blob = Stamp::of(entry).encode();
    let options = UpdateOptions::default().metadata(metadata(entry)).blob(&blob).update_if_in_sync().mark_in_sync();
    let options = if entry.is_folder { options } else { options.dehydrate() };
    Placeholder::options()
        .write_access()
        .exclusive()
        .open(path)
        .and_then(|mut p| p.update(options, None).map(|_| ()))
        .map_err(std::io::Error::other)
}

/// Throw away a local edit already kept elsewhere (a conflicted copy): the
/// placeholder points at the server copy again, in sync, contents dropped.
pub fn revert(path: &Path, entry: &Entry) -> std::io::Result<()> {
    let blob = Stamp::of(entry).encode();
    let mut placeholder =
        Placeholder::options().write_access().exclusive().open(path).map_err(std::io::Error::other)?;
    // An app that saved by writing a new file left a plain file: make it a placeholder again.
    let _ = placeholder.convert_to_placeholder(ConvertOptions::default().blob(blob.clone()), None);
    let options = UpdateOptions::default().metadata(metadata(entry)).blob(&blob).mark_in_sync().dehydrate();
    placeholder.update(options, None).map(|_| ()).map_err(std::io::Error::other)
}

/// Remove what the server no longer has, keeping anything changed or made here.
/// Returns whether everything went.
pub fn remove_synced(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return true };
    if !meta.is_dir() {
        return match inspect(path) {
            Ok(Some((_, true, _))) => std::fs::remove_file(path).is_ok(),
            _ => false,
        };
    }
    // A folder never browsed holds nothing on disk; listing it would only download its children.
    if !cfapi::is_populated(path) && std::fs::remove_dir(path).is_ok() {
        return true;
    }
    let mut all = true;
    if let Ok(items) = std::fs::read_dir(path) {
        for item in items.flatten() {
            all &= remove_synced(&item.path());
        }
    }
    all && std::fs::remove_dir(path).is_ok()
}

/// Forget the server copy a placeholder stood for, so its folder uploads again.
/// The identity is never left empty: cloud-filter reads an empty one as a null slice.
pub fn unstamp(path: &Path) -> std::io::Result<()> {
    Placeholder::options()
        .write_access()
        .open(path)
        .and_then(|mut p| {
            p.update(UpdateOptions::default().blob(Stamp::UNSTAMPED).mark_not_in_sync(), None).map(|_| ())
        })
        .map_err(std::io::Error::other)
}

/// A file's size and write time, to tell whether it changed while uploading.
pub type Snapshot = Option<(u64, std::time::SystemTime)>;

pub fn snapshot(path: &Path) -> Snapshot {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}
