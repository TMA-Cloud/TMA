//! The drive's logic, shared by the FUSE and NFS adapters: resolving paths
//! against short-lived folder listings, staging file contents in local temp
//! files, and the bookkeeping that keeps editors' save patterns working
//! (create-empty-then-write, write-temp-then-rename).

mod handle;

pub use handle::Handle;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};

use crate::backend::{Backend, Entry};
use crate::paths::{self, ROOT};

/// Listings are reused this long, so a save dialog's burst of lookups costs one request.
const DIR_TTL: Duration = Duration::from_secs(5);
const MAX_TRACKED: usize = 4096;
/// Free space reported when the account has no limit (1 PiB), never below 1 GiB.
const SYNTHETIC_CAPACITY: u64 = 1 << 50;
const MIN_FREE: u64 = 1 << 30;

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum FsError {
    #[error("not found")]
    NotFound,
    #[error("path not found")]
    PathNotFound,
    #[error("access denied")]
    AccessDenied,
    #[error("directory not empty")]
    NotEmpty,
    #[error("end of file")]
    EndOfFile,
    #[error("{0}")]
    Io(String),
}

pub type FsResult<T> = Result<T, FsError>;

/// A file or folder at a path; `id` is `None` for the root and for files not yet uploaded.
#[derive(Debug, Clone)]
pub struct Node {
    pub id: Option<String>,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: DateTime<Utc>,
    pub accessed: Option<DateTime<Utc>>,
    pub path: String,
}

impl Node {
    fn root() -> Self {
        Self {
            id: None,
            name: String::new(),
            is_folder: true,
            size: 0,
            modified: Utc::now(),
            accessed: None,
            path: ROOT.into(),
        }
    }
}

struct Listing {
    children: Arc<Vec<Node>>,
    fetched: Instant,
}

pub struct Core {
    backend: Arc<dyn Backend>,
    staging: PathBuf,
    /// Map server names to names Windows accepts (reserved characters to private-use ones).
    windows_names: bool,
    dirs: Mutex<HashMap<String, Listing>>,
    /// Ids of items this drive created or renamed, by path, until a listing shows them.
    created: Mutex<HashMap<String, String>>,
    /// Empty files an app created but never wrote: shown locally, never uploaded.
    local_empty: Mutex<HashSet<String>>,
    path_locks: Vec<Mutex<()>>,
    pub deny_read: AtomicBool,
    /// Paths TMA Cloud itself opened or copied, readable in save-only mode until they expire.
    readable: Mutex<Vec<(String, Instant)>>,
    /// Bumped whenever every listing is dropped, so adapters can resync.
    generation: AtomicU64,
    total: AtomicU64,
    free: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Core {
    pub fn new(backend: Arc<dyn Backend>, staging: PathBuf, windows_names: bool) -> std::io::Result<Self> {
        std::fs::create_dir_all(&staging)?;
        let core = Self {
            backend,
            staging,
            windows_names,
            dirs: Mutex::new(HashMap::new()),
            created: Mutex::new(HashMap::new()),
            local_empty: Mutex::new(HashSet::new()),
            path_locks: (0..64).map(|_| Mutex::new(())).collect(),
            deny_read: AtomicBool::new(false),
            readable: Mutex::new(Vec::new()),
            generation: AtomicU64::new(0),
            total: AtomicU64::new(SYNTHETIC_CAPACITY),
            free: AtomicU64::new(SYNTHETIC_CAPACITY),
        };
        core.clean_staging(false);
        Ok(core)
    }

    pub fn backend(&self) -> &dyn Backend {
        self.backend.as_ref()
    }

    /// Serializes creates and uploads per path, so two handles cannot both create one file.
    fn path_lock(&self, path: &str) -> MutexGuard<'_, ()> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        paths::key(path).hash(&mut h);
        let index = (h.finish() as usize) % self.path_locks.len();
        lock(&self.path_locks[index])
    }

    /// Let other apps read `path` and what is under it for `time`, even in save-only
    /// mode: the user opened or copied it from TMA Cloud on purpose.
    pub fn allow_read(&self, path: &str, time: Duration) {
        let now = Instant::now();
        let mut readable = lock(&self.readable);
        readable.retain(|(_, until)| *until > now);
        readable.push((paths::normalize(path), now + time));
    }

    /// Whether another app may read `path`: save-only is off, or TMA Cloud opened it.
    pub fn may_read(&self, path: &str) -> bool {
        if !self.deny_read.load(Ordering::Relaxed) {
            return true;
        }
        let now = Instant::now();
        lock(&self.readable).iter().any(|(root, until)| *until > now && paths::is_at_or_under(path, root))
    }

    /// The drive path of an item from its server folder names and name.
    pub fn local_path(&self, folders: &[String], name: &str) -> String {
        let mut path = ROOT.to_string();
        for part in folders.iter().map(String::as_str).chain(std::iter::once(name)) {
            path = paths::join(&path, &self.to_local_name(part));
        }
        path
    }

    fn to_local_name(&self, server: &str) -> String {
        if self.windows_names { tma_core::names::server_to_windows(server) } else { server.to_string() }
    }

    pub(crate) fn to_server_name(&self, local: &str) -> String {
        if self.windows_names { tma_core::names::windows_to_server(local) } else { local.to_string() }
    }

    fn node_from(&self, entry: Entry, parent: &str) -> Option<Node> {
        let name = self.to_local_name(&entry.name);
        paths::is_safe_name(&name).then(|| Node {
            path: paths::join(parent, &name),
            id: Some(entry.id),
            name,
            is_folder: entry.is_folder,
            size: entry.size,
            modified: entry.modified,
            accessed: entry.accessed,
        })
    }

    fn list_dir(&self, folder: &Node) -> FsResult<Arc<Vec<Node>>> {
        let key = paths::key(&folder.path);
        if let Some(listing) = lock(&self.dirs).get(&key).filter(|l| l.fetched.elapsed() < DIR_TTL) {
            return Ok(listing.children.clone());
        }
        let entries = self.backend.list(folder.id.as_deref()).map_err(FsError::Io)?;
        let children: Arc<Vec<Node>> =
            Arc::new(entries.into_iter().filter_map(|e| self.node_from(e, &folder.path)).collect());
        let mut dirs = lock(&self.dirs);
        if dirs.len() >= 1024 && !dirs.contains_key(&key) {
            dirs.clear();
        }
        dirs.insert(key, Listing { children: children.clone(), fetched: Instant::now() });
        Ok(children)
    }

    /// A folder's children, plus empty placeholder files apps created here.
    pub fn children(&self, folder: &Node) -> FsResult<Vec<Node>> {
        let mut children = (*self.list_dir(folder)?).clone();
        let empties: Vec<String> = lock(&self.local_empty).iter().cloned().collect();
        for path in empties {
            if paths::parent(&path).map(|p| paths::key(&p)) != Some(paths::key(&folder.path)) {
                continue;
            }
            let name = paths::leaf(&path).to_string();
            if children.iter().any(|c| c.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            children.push(Node {
                id: None,
                name,
                is_folder: false,
                size: 0,
                modified: Utc::now(),
                accessed: None,
                path,
            });
        }
        Ok(children)
    }

    pub fn resolve(&self, path: &str) -> FsResult<Option<Node>> {
        let path = paths::normalize(path);
        let mut current = Node::root();
        if path == ROOT {
            return Ok(Some(current));
        }
        for part in path.split('\\').filter(|p| !p.is_empty()) {
            if !current.is_folder {
                return Ok(None);
            }
            match self.children(&current)?.into_iter().find(|c| c.name.eq_ignore_ascii_case(part)) {
                Some(next) => current = next,
                None => return Ok(None),
            }
        }
        Ok(Some(current))
    }

    fn find_child(&self, parent_id: Option<&str>, name: &str, folder: bool) -> FsResult<Option<Entry>> {
        let entries = self.backend.list(parent_id).map_err(FsError::Io)?;
        let wanted = self.to_server_name(name);
        Ok(entries.into_iter().find(|e| e.is_folder == folder && e.name.eq_ignore_ascii_case(&wanted)))
    }

    pub fn invalidate(&self, dir: &str) {
        lock(&self.dirs).remove(&paths::key(dir));
    }

    /// Forget every listing (a change was made elsewhere).
    pub fn invalidate_all(&self) {
        lock(&self.dirs).clear();
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    fn track_created(&self, path: &str, id: &str) {
        let mut created = lock(&self.created);
        if created.len() >= MAX_TRACKED {
            created.clear();
        }
        created.insert(paths::key(path), id.to_string());
    }

    fn created_id(&self, path: &str) -> Option<String> {
        lock(&self.created).get(&paths::key(path)).cloned()
    }

    fn track_empty(&self, path: &str) {
        let mut empties = lock(&self.local_empty);
        if empties.len() >= MAX_TRACKED {
            empties.clear();
        }
        empties.insert(path.to_string());
    }

    fn untrack_empty(&self, path: &str) {
        lock(&self.local_empty).retain(|p| paths::key(p) != paths::key(path));
    }

    fn forget_subtree(&self, root: &str) {
        lock(&self.created).retain(|k, _| !paths::is_at_or_under(k, root));
        lock(&self.local_empty).retain(|k| !paths::is_at_or_under(k, root));
        lock(&self.dirs).retain(|k, _| !paths::is_at_or_under(k, root));
    }

    fn rekey_subtree(&self, old: &str, new: &str) {
        let old_len = paths::key(old).len();
        let moved: Vec<(String, String)> = {
            let mut created = lock(&self.created);
            let keys: Vec<String> = created.keys().filter(|k| paths::is_at_or_under(k, old)).cloned().collect();
            keys.into_iter()
                .filter_map(|k| created.remove(&k).map(|id| (format!("{new}{}", &k[old_len.min(k.len())..]), id)))
                .collect()
        };
        for (path, id) in moved {
            self.track_created(&path, &id);
        }
        let empties: Vec<String> = {
            let mut set = lock(&self.local_empty);
            let hits: Vec<String> = set.iter().filter(|k| paths::is_at_or_under(k, old)).cloned().collect();
            for h in &hits {
                set.remove(h);
            }
            hits
        };
        for path in empties {
            self.track_empty(&format!("{new}{}", &path[old.len().min(path.len())..]));
        }
        lock(&self.dirs).retain(|k, _| !paths::is_at_or_under(k, old));
    }

    pub(crate) fn new_staging_file(&self) -> PathBuf {
        self.staging.join(format!("{}.tmp", uuid::Uuid::new_v4().simple()))
    }

    /// Remove staging files left by a crash (older than an hour), or all of them.
    pub fn clean_staging(&self, all: bool) {
        let Ok(entries) = std::fs::read_dir(&self.staging) else { return };
        let cutoff = std::time::SystemTime::now() - Duration::from_secs(3600);
        for entry in entries.flatten() {
            let old = entry.metadata().and_then(|m| m.modified()).map(|m| m < cutoff).unwrap_or(true);
            if all || old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Refresh the volume size from the account's quota.
    pub fn refresh_space(&self) {
        let Ok(space) = self.backend.space() else { return };
        match space.total {
            Some(total) => {
                self.total.store(total, Ordering::Relaxed);
                self.free.store(total.saturating_sub(space.used), Ordering::Relaxed);
            }
            None => {
                self.total.store(SYNTHETIC_CAPACITY, Ordering::Relaxed);
                self.free.store(SYNTHETIC_CAPACITY.saturating_sub(space.used).max(MIN_FREE), Ordering::Relaxed);
            }
        }
    }

    pub fn space(&self) -> (u64, u64) {
        (self.total.load(Ordering::Relaxed), self.free.load(Ordering::Relaxed))
    }
}

#[cfg(test)]
mod tests;
