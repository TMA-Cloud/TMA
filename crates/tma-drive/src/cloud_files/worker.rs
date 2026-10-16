//! The sync loop: uploads what changed in the folder (seen by a watcher) and
//! brings populated folders in line with the server when it reports changes.
//! One thread does both, so an upload and its restamp never race a resync.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::backend::Entry;
use crate::cloud_files::local;
use crate::core::{Core, Node};
use crate::paths;
use crate::sync_plan::{self, Fix, Stamp, Upload};

/// A folder uploads once nothing in it has changed for this long.
const QUIET: Duration = Duration::from_millis(1500);
/// A server delete waits this long, so a save that deletes and rewrites a file keeps its id.
const DELETE_GRACE: Duration = Duration::from_secs(4);
/// A full resync runs at least this often, in case a change event was missed.
const RESYNC_EVERY: Duration = Duration::from_secs(120);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Shared {
    pub core: Arc<Core>,
    pub root: PathBuf,
    /// Folders with local changes, by when they last changed.
    dirty: Mutex<HashMap<PathBuf, Instant>>,
    /// Server deletes waiting out the grace period: path key → (id, path, when).
    deletes: Mutex<HashMap<String, (String, PathBuf, Instant)>>,
    wake: Condvar,
    stop: AtomicBool,
}

impl Shared {
    pub fn new(core: Arc<Core>, root: PathBuf) -> Self {
        Self {
            core,
            root,
            dirty: Mutex::new(HashMap::new()),
            deletes: Mutex::new(HashMap::new()),
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

    pub fn queue_delete(&self, id: String, path: PathBuf) {
        let key = paths::key(&path.to_string_lossy());
        lock(&self.deletes).insert(key, (id, path, Instant::now()));
        self.wake.notify_one();
    }

    /// A file deleted moments ago and now written again at the same path keeps its server id.
    fn take_delete(&self, path: &Path) -> Option<String> {
        lock(&self.deletes).remove(&paths::key(&path.to_string_lossy())).map(|(id, _, _)| id)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        self.wake.notify_one();
    }

    fn folder(&self, dir: &Path) -> Option<Node> {
        let rel = self.rel(dir)?;
        self.core.resolve(&rel).ok().flatten().filter(|n| n.is_folder && (n.id.is_some() || rel == paths::ROOT))
    }

    fn server(&self, node: &Node) -> Option<Vec<Entry>> {
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
            let backend = self.core.backend();
            let result = match step {
                Upload::File { replace, .. } => match replace.or_else(|| self.take_delete(&path)) {
                    Some(id) => backend.replace(&id, &server_name, &path).map(|_| id),
                    None => backend.upload(node.id.as_deref(), &server_name, &path),
                },
                Upload::Changed { id, .. } => backend.replace(&id, &server_name, &path).map(|_| id),
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
        if !uploaded.is_empty() {
            self.core.invalidate(&node.path);
            let server = self.server(&node).unwrap_or_default();
            for (path, id, before) in uploaded {
                // Edited again while uploading: leave it unsynced so the next pass sends it.
                if local::snapshot(&path) != before {
                    done = false;
                    continue;
                }
                let stamp = server.iter().find(|e| e.id == id).map(Stamp::of).unwrap_or(Stamp { id, version: 0 });
                if let Err(err) = local::adopt(&path, &stamp) {
                    log::warn!("[drive] could not mark {} synced: {err}", path.display());
                    done = false;
                }
            }
        }
        done
    }

    /// Bring one populated folder in line with the server; returns its populated subfolders.
    pub fn resync_folder(&self, dir: &Path) -> Vec<PathBuf> {
        let Some(node) = self.folder(dir) else { return Vec::new() };
        let (Some(server), Ok(folder)) = (self.server(&node), local::read(dir)) else { return Vec::new() };
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
            if let Err(err) = outcome {
                log::debug!("[drive] {fix:?} in {}: {err}", dir.display());
            }
        }
        folder.populated
    }

    fn resync_all(&self) {
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
            let keys: Vec<String> =
                deletes.iter().filter(|(_, (_, _, at))| at.elapsed() >= DELETE_GRACE).map(|(k, _)| k.clone()).collect();
            keys.iter().filter_map(|k| deletes.remove(k)).map(|(id, path, _)| (id, path)).collect()
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
        let mut resync_due = true;
        let mut last_resync = Instant::now();
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
                if !self.upload_folder(&dir) {
                    // Retry after another quiet period (an app still has the file, or the server failed).
                    self.changed(dir);
                }
            }
            let now = self.core.generation();
            if now != generation || last_resync.elapsed() >= RESYNC_EVERY {
                generation = now;
                resync_due = true;
            }
            if resync_due {
                resync_due = false;
                last_resync = Instant::now();
                self.resync_all();
            }
        }
    }
}
