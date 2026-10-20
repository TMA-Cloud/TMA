//! The sync loop: uploads what changed in the folder (seen by a watcher) and
//! brings populated folders in line with the server when it reports changes.
//! One thread does both, so an upload and its restamp never race a resync.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::backend::{CONFLICT, Entry};
use crate::cloud_files::feed::Feed;
use crate::cloud_files::local;
use crate::core::{Core, Node};
use crate::paths;
use crate::sync_plan::{self, Fix, Stamp, Upload};

/// A folder uploads once nothing in it has changed for this long.
const QUIET: Duration = Duration::from_millis(1500);
/// A server delete waits this long, so a save that deletes and rewrites a file keeps its id.
const DELETE_GRACE: Duration = Duration::from_secs(4);
/// Without an event, the change feed is still asked this often (an event can be lost).
const CHECK_EVERY: Duration = Duration::from_secs(60);
/// Every open folder is re-listed this often anyway, for anything the feed cannot see.
const RESYNC_EVERY: Duration = Duration::from_secs(30 * 60);
/// Events arriving together are answered with one question to the change feed.
const GATHER: Duration = Duration::from_secs(1);
/// Without a change feed, every open folder is re-listed on events, and at least this often.
const FALLBACK_EVERY: Duration = Duration::from_secs(120);

/// How a local file's save went.
enum Saved {
    Replaced,
    /// Someone else saved first; the local edit went up as a conflicted copy.
    Conflicted,
}

pub(super) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Shared {
    pub core: Arc<Core>,
    pub root: PathBuf,
    /// Folders with local changes, by when they last changed.
    dirty: Mutex<HashMap<PathBuf, Instant>>,
    /// The server file and version each synced path last held, by path key. Apps
    /// save by writing a new file over the placeholder, which loses its stamp; the
    /// new file still saves against the version it replaced.
    synced: Mutex<HashMap<String, (String, i64)>>,
    /// Files already kept as a conflicted copy, by path key, as they were then:
    /// not sent again until they change, so a failed revert cannot repeat the copy.
    kept: Mutex<HashMap<String, local::Snapshot>>,
    /// Files uploaded but not yet marked synced, because the app that saved them
    /// still holds them open (Excel does): by path key, as they were sent.
    sent: Mutex<HashMap<String, local::Snapshot>>,
    /// Server deletes waiting out the grace period: path key → (id, version, path, when).
    deletes: Mutex<HashMap<String, (String, i64, PathBuf, Instant)>>,
    /// Where the change feed left off.
    pub(super) cursor: Mutex<Option<String>>,
    /// Open (populated) folders by server id; the root is `None`.
    pub(super) open_folders: Mutex<HashMap<Option<String>, PathBuf>>,
    wake: Condvar,
    stop: AtomicBool,
}

impl Shared {
    pub fn new(core: Arc<Core>, root: PathBuf) -> Self {
        Self {
            core,
            root,
            dirty: Mutex::new(HashMap::new()),
            synced: Mutex::new(HashMap::new()),
            kept: Mutex::new(HashMap::new()),
            sent: Mutex::new(HashMap::new()),
            deletes: Mutex::new(HashMap::new()),
            cursor: Mutex::new(None),
            open_folders: Mutex::new(HashMap::new()),
            wake: Condvar::new(),
            stop: AtomicBool::new(false),
        }
    }

    /// The drive path ("\Folder\file") for a local path, if it is in the sync root.
    pub fn rel(&self, path: &Path) -> Option<String> {
        let full = path.to_string_lossy().replace('/', "\\");
        let root = self.root.to_string_lossy().replace('/', "\\");
        let root = root.trim_end_matches('\\');
        if full.len() < root.len() || !full[..root.len()].eq_ignore_ascii_case(root) {
            return None;
        }
        let rest = &full[root.len()..];
        if !rest.is_empty() && !rest.starts_with('\\') {
            return None;
        }
        Some(paths::normalize(if rest.is_empty() { paths::ROOT } else { rest }))
    }

    pub fn changed(&self, dir: PathBuf) {
        if self.rel(&dir).is_none() {
            return;
        }
        lock(&self.dirty).insert(dir, Instant::now());
        self.wake.notify_one();
    }

    pub fn queue_delete(&self, id: String, version: i64, path: PathBuf) {
        let key = paths::key(&path.to_string_lossy());
        lock(&self.deletes).insert(key, (id, version, path, Instant::now()));
        self.wake.notify_one();
    }

    fn note_synced(&self, path: &Path, stamp: &Stamp) {
        lock(&self.synced).insert(paths::key(&path.to_string_lossy()), (stamp.id.clone(), stamp.version));
    }

    /// The version a file written over the synced copy of `id` at `path` started from.
    fn synced_version(&self, path: &Path, id: &str) -> Option<i64> {
        lock(&self.synced).get(&paths::key(&path.to_string_lossy())).filter(|(sid, _)| sid == id).map(|(_, v)| *v)
    }

    /// Mark a file already on the server synced; false while its app still holds it.
    fn mark_sent(&self, path: &Path, key: &str) -> bool {
        let Some((id, version)) = lock(&self.synced).get(key).cloned() else {
            lock(&self.sent).remove(key);
            return true;
        };
        let marked = local::adopt(path, &Stamp { id, version }).is_ok();
        if marked {
            lock(&self.sent).remove(key);
        }
        marked
    }

    /// A file deleted moments ago and now written again at the same path keeps its
    /// server id, and the version it was synced at (a save that deletes and rewrites).
    fn take_delete(&self, path: &Path) -> Option<(String, i64)> {
        lock(&self.deletes).remove(&paths::key(&path.to_string_lossy())).map(|(id, version, _, _)| (id, version))
    }

    /// Replace a server file with the local one. If someone else saved after this
    /// copy was synced, the server refuses; the local edit is then uploaded beside
    /// it as a conflicted copy, so neither save is lost.
    fn save(
        &self,
        folder: &Node,
        id: &str,
        server_name: &str,
        path: &Path,
        base: Option<i64>,
    ) -> Result<Saved, String> {
        let backend = self.core.backend();
        match backend.replace(id, server_name, path, base) {
            Ok(_) => Ok(Saved::Replaced),
            Err(err) if err == CONFLICT => {
                let when = chrono::Local::now().format("%Y-%m-%d %H%M").to_string();
                let copy = sync_plan::conflict_name(server_name, &when);
                backend.upload(folder.id.as_deref(), &copy, path)?;
                log::warn!(
                    "[drive] {} changed on the server since it was opened; kept this edit as {copy}",
                    path.display()
                );
                Ok(Saved::Conflicted)
            }
            Err(err) => Err(err),
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }

    pub(super) fn folder(&self, dir: &Path) -> Option<Node> {
        let rel = self.rel(dir)?;
        self.core.resolve(&rel).ok().flatten().filter(|n| n.is_folder && (n.id.is_some() || rel == paths::ROOT))
    }

    pub(super) fn server(&self, node: &Node) -> Option<Vec<Entry>> {
        match self.core.children(node) {
            Ok(children) => Some(children.iter().filter_map(local::entry).collect()),
            Err(err) => {
                log::warn!("[drive] listing {} failed: {err:?}", node.path);
                None
            }
        }
    }

    /// Upload what changed in one folder. Returns false to retry later.
    fn upload_folder(&self, dir: &Path) -> bool {
        let Ok(folder) = local::read(dir) else { return true };
        let Some(node) = self.folder(dir) else {
            // The folder itself is new: its parent uploads it first.
            if let Some(parent) = dir.parent().filter(|p| self.rel(p).is_some()) {
                self.changed(parent.to_path_buf());
            }
            return true;
        };
        let Some(server) = self.server(&node) else { return false };
        let mut done = true;
        let mut uploaded: Vec<(PathBuf, String, local::Snapshot)> = Vec::new();
        let mut conflicted: Vec<(PathBuf, String, local::Snapshot)> = Vec::new();
        for step in sync_plan::uploads(&folder.items, &server) {
            log::debug!("[drive] upload in {}: {step:?}", dir.display());
            let name = match &step {
                Upload::File { name, .. } | Upload::Folder { name, .. } | Upload::Changed { name, .. } => name.clone(),
            };
            if folder.busy.contains(&name) {
                done = false;
                continue;
            }
            let path = dir.join(&name);
            let server_name = self.core.to_server_name(&name);
            let before = local::snapshot(&path);
            let key = paths::key(&path.to_string_lossy());
            if lock(&self.kept).get(&key) == Some(&before) {
                continue;
            }
            // Sent unchanged before: sending it again would only bump its version.
            if lock(&self.sent).get(&key) == Some(&before) {
                done &= self.mark_sent(&path, &key);
                continue;
            }
            let backend = self.core.backend();
            // A new file over a same-named server one replaces it as asked; a rewrite keeps its version check.
            let target = match &step {
                Upload::File { replace, .. } => {
                    let deleted = self.take_delete(&path).map(|(id, v)| (id, sync_plan::base(v)));
                    // Over a server file of the same name: checked if it replaced that file's synced copy.
                    deleted.or_else(|| {
                        replace.clone().map(|id| {
                            let base = self.synced_version(&path, &id).and_then(sync_plan::base);
                            (id, base)
                        })
                    })
                }
                // An earlier upload of this file that could not restamp it moved the version on.
                Upload::Changed { id, base, .. } => {
                    let synced = self.synced_version(&path, id).unwrap_or(*base);
                    Some((id.clone(), sync_plan::base(synced.max(*base))))
                }
                Upload::Folder { .. } => None,
            };
            if let Some((id, base)) = target {
                match self.save(&node, &id, &server_name, &path, base) {
                    Ok(Saved::Replaced) => uploaded.push((path, id, before)),
                    Ok(Saved::Conflicted) => {
                        lock(&self.kept).insert(paths::key(&path.to_string_lossy()), before);
                        conflicted.push((path, id, before));
                    }
                    Err(err) => {
                        log::warn!("[drive] upload of {} failed: {err}", path.display());
                        done = false;
                    }
                }
                continue;
            }
            let result = match step {
                Upload::File { .. } | Upload::Changed { .. } => backend.upload(node.id.as_deref(), &server_name, &path),
                Upload::Folder { existing, .. } => {
                    let made = existing.map(Ok).unwrap_or_else(|| backend.mkdir(node.id.as_deref(), &server_name));
                    match made.and_then(|id| local::adopt(&path, &Stamp { id, version: 0 }).map_err(|e| e.to_string()))
                    {
                        Ok(()) => {
                            // A resync must not see the old listing and remove the new folder.
                            self.core.invalidate(&node.path);
                            self.changed(path);
                            continue;
                        }
                        Err(err) => Err(err),
                    }
                }
            };
            match result {
                Ok(id) => uploaded.push((path, id, before)),
                Err(err) => {
                    log::warn!("[drive] upload of {} failed: {err}", path.display());
                    done = false;
                }
            }
        }
        if !uploaded.is_empty() || !conflicted.is_empty() {
            self.core.invalidate(&node.path);
            let server = self.server(&node).unwrap_or_default();
            // The edit is safe in its copy: the original goes back to the server's version.
            for (path, id, before) in conflicted {
                let current = server.iter().find(|e| e.id == id);
                let reverted =
                    local::snapshot(&path) == before && current.is_some_and(|e| local::revert(&path, e).is_ok());
                done &= reverted;
            }
            for (path, id, before) in uploaded {
                let found = server.iter().find(|e| e.id == id).map(Stamp::of);
                // The server holds this content now; the next save of the file builds on it.
                if let Some(stamp) = &found {
                    self.note_synced(&path, stamp);
                }
                // Edited again while uploading: leave it unsynced so the next pass sends it.
                if local::snapshot(&path) != before {
                    done = false;
                    continue;
                }
                let stamp = found.unwrap_or(Stamp { id, version: 0 });
                if let Err(err) = local::adopt(&path, &stamp) {
                    log::debug!("[drive] {} stays unmarked while an app holds it: {err}", path.display());
                    lock(&self.sent).insert(paths::key(&path.to_string_lossy()), before);
                    done = false;
                }
            }
        }
        done
    }

    /// Bring one populated folder in line with the server; returns its populated subfolders.
    pub fn resync_folder(&self, dir: &Path) -> Vec<PathBuf> {
        let Some(node) = self.folder(dir) else { return Vec::new() };
        self.note_folder(node.id.clone(), dir);
        let (Some(server), Ok(folder)) = (self.server(&node), local::read(dir)) else { return Vec::new() };
        for item in folder.items.iter().filter(|i| !i.is_dir && i.in_sync) {
            if let Some(stamp) = &item.stamp {
                self.note_synced(&dir.join(&item.name), stamp);
            }
        }
        for fix in sync_plan::reconcile(&folder.items, &server) {
            log::debug!("[drive] resync {}: {fix:?}", dir.display());
            let touched = match &fix {
                Fix::Create(e) => &e.name,
                Fix::Update { name, .. } | Fix::Rename { from: name, .. } | Fix::Remove(name) => name,
            };
            if folder.busy.contains(touched) {
                continue;
            }
            let outcome = match &fix {
                Fix::Create(entry) => local::create(dir, entry),
                Fix::Update { name, entry } => local::refresh(&dir.join(name), entry),
                Fix::Rename { from, entry } => std::fs::rename(dir.join(from), dir.join(&entry.name)),
                Fix::Remove(name) => {
                    let path = dir.join(name);
                    if !local::remove_synced(&path) && path.is_dir() {
                        // Something made here is inside: keep the folder and upload it afresh.
                        let _ = local::unstamp(&path);
                        self.changed(path);
                    }
                    Ok(())
                }
            };
            match (&outcome, &fix) {
                (Err(err), _) => log::debug!("[drive] {fix:?} in {}: {err}", dir.display()),
                (Ok(()), Fix::Create(entry) | Fix::Update { entry, .. }) if !entry.is_folder => {
                    self.note_synced(&dir.join(&entry.name), &Stamp::of(entry));
                }
                _ => {}
            }
        }
        self.mark_editors(dir, &folder.items, &server);
        folder.populated
    }

    pub(super) fn resync_all(&self) {
        let mut queue = vec![self.root.clone()];
        while let Some(dir) = queue.pop() {
            if self.stop.load(Ordering::Relaxed) {
                return;
            }
            queue.extend(self.resync_folder(&dir));
        }
    }

    /// Queue every populated folder, so changes made while the app was closed upload.
    fn scan_all(&self) {
        let mut queue = vec![self.root.clone()];
        let past = Instant::now().checked_sub(QUIET).unwrap_or_else(Instant::now);
        while let Some(dir) = queue.pop() {
            if let Ok(folder) = local::read(&dir) {
                queue.extend(folder.populated);
            }
            lock(&self.dirty).insert(dir, past);
        }
    }

    fn run_deletes(&self) {
        let due: Vec<(String, PathBuf)> = {
            let mut deletes = lock(&self.deletes);
            let keys: Vec<String> = deletes
                .iter()
                .filter(|(_, (_, _, _, at))| at.elapsed() >= DELETE_GRACE)
                .map(|(k, _)| k.clone())
                .collect();
            keys.iter().filter_map(|k| deletes.remove(k)).map(|(id, _, path, _)| (id, path)).collect()
        };
        for (id, path) in due {
            // The delete was cancelled (the file is still there): keep the server copy.
            if path.exists() {
                continue;
            }
            match self.core.backend().delete(&id) {
                Ok(()) => {
                    if let Some(parent) = path.parent().and_then(|p| self.rel(p)) {
                        self.core.invalidate(&parent);
                    }
                }
                Err(err) => log::warn!("[drive] delete of {} failed: {err}", path.display()),
            }
        }
    }

    fn take_quiet(&self) -> Vec<PathBuf> {
        let mut dirty = lock(&self.dirty);
        let ready: Vec<PathBuf> =
            dirty.iter().filter(|(_, at)| at.elapsed() >= QUIET).map(|(p, _)| p.clone()).collect();
        for dir in &ready {
            dirty.remove(dir);
        }
        ready
    }

    pub fn run(self: Arc<Self>) {
        self.scan_all();
        let mut generation = self.core.generation();
        let mut last_full: Option<Instant> = None;
        let mut last_check = Instant::now();
        let mut pending = false;
        let mut has_feed = true;
        while !self.stop.load(Ordering::Relaxed) {
            {
                let dirty = lock(&self.dirty);
                let _ = self.wake.wait_timeout(dirty, Duration::from_millis(500));
            }
            if self.stop.load(Ordering::Relaxed) {
                break;
            }
            self.run_deletes();
            for dir in self.take_quiet() {
                let done = self.upload_folder(&dir);
                // A document closed with its last save not yet up keeps its lock until it is.
                self.settle_edits(&dir, done);
                if !done {
                    // Retry after another quiet period (an app still has the file, or the server failed).
                    self.changed(dir);
                }
            }
            let now = self.core.generation();
            pending |= now != generation;
            generation = now;
            if last_full.is_none_or(|t| t.elapsed() >= RESYNC_EVERY) {
                (last_full, last_check, pending) = (Some(Instant::now()), Instant::now(), false);
                self.full_resync();
            } else if !has_feed {
                if pending || last_check.elapsed() >= FALLBACK_EVERY {
                    (last_check, pending) = (Instant::now(), false);
                    self.resync_all();
                }
            } else if (pending && last_check.elapsed() >= GATHER) || last_check.elapsed() >= CHECK_EVERY {
                (last_check, pending) = (Instant::now(), false);
                match self.catch_up() {
                    Feed::Done | Feed::Failed => {}
                    Feed::Full => {
                        last_full = Some(Instant::now());
                        self.full_resync();
                    }
                    Feed::Unavailable => {
                        has_feed = false;
                        self.resync_all();
                    }
                }
            }
        }
    }
}
