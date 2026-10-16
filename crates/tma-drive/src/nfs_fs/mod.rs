//! The macOS adapter: a local NFSv3 server the system's own NFS client mounts,
//! so Cloud Drive needs no kernel extension (no macFUSE). NFS has no open or
//! close, so files keep a staged handle while in use and upload once idle.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use nfsserve::nfs::{fattr3, fileid3, filename3, ftype3, nfspath3, nfsstat3, nfstime3, sattr3, set_size3, specdata3};
use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use nfsserve::vfs::{DirEntry, NFSFileSystem, ReadDirResult, VFSCapabilities};

use crate::core::{Core, FsError, Handle, Node};
use crate::ids::{IdTable, ROOT_ID};
use crate::paths;

/// A written file uploads once no write has arrived for this long.
const WRITE_IDLE: Duration = Duration::from_secs(2);
/// A file only read keeps its downloaded copy this long after the last read.
const READ_IDLE: Duration = Duration::from_secs(30);

impl From<FsError> for nfsstat3 {
    fn from(err: FsError) -> Self {
        match err {
            FsError::NotFound | FsError::PathNotFound => nfsstat3::NFS3ERR_NOENT,
            FsError::AccessDenied => nfsstat3::NFS3ERR_ACCES,
            FsError::NotEmpty => nfsstat3::NFS3ERR_NOTEMPTY,
            FsError::EndOfFile => nfsstat3::NFS3ERR_IO,
            FsError::Io(msg) => {
                log::warn!("[drive] {msg}");
                nfsstat3::NFS3ERR_IO
            }
        }
    }
}

struct Open {
    handle: Arc<Handle>,
    last: Instant,
    written: bool,
}

struct Inner {
    core: Arc<Core>,
    ids: Mutex<IdTable>,
    open: Mutex<HashMap<u64, Open>>,
    uid: u32,
    gid: u32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn time(at: chrono::DateTime<chrono::Utc>) -> nfstime3 {
    nfstime3 { seconds: at.timestamp().max(0) as u32, nseconds: at.timestamp_subsec_nanos() }
}

impl Inner {
    fn attr(&self, id: u64, node: &Node, size: u64) -> fattr3 {
        let modified = time(node.modified);
        let size = if node.is_folder { 0 } else { size };
        fattr3 {
            ftype: if node.is_folder { ftype3::NF3DIR } else { ftype3::NF3REG },
            mode: if node.is_folder { 0o755 } else { 0o644 },
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            size,
            used: size,
            rdev: specdata3::default(),
            fsid: 0,
            fileid: id,
            atime: node.accessed.map(time).unwrap_or(modified),
            mtime: modified,
            ctime: modified,
        }
    }

    fn path(&self, id: u64) -> Result<String, nfsstat3> {
        lock(&self.ids).path(id).ok_or(nfsstat3::NFS3ERR_STALE)
    }

    fn child(&self, dir: u64, name: &filename3) -> Result<String, nfsstat3> {
        let name = std::str::from_utf8(&name.0).map_err(|_| nfsstat3::NFS3ERR_INVAL)?;
        Ok(paths::join(&self.path(dir)?, name))
    }

    /// A file in use: the open handle, else the folder listing.
    fn getattr(&self, id: u64) -> Result<fattr3, nfsstat3> {
        if let Some(open) = lock(&self.open).get(&id) {
            return Ok(self.attr(id, &open.handle.node(), open.handle.size()));
        }
        let path = self.path(id)?;
        let node = self.core.resolve(&path)?.ok_or(nfsstat3::NFS3ERR_NOENT)?;
        Ok(self.attr(id, &node, node.size))
    }

    /// The handle for a file, opened (and remembered) on first use.
    fn handle(&self, id: u64, written: bool) -> Result<Arc<Handle>, nfsstat3> {
        let mut open = lock(&self.open);
        if let Some(entry) = open.get_mut(&id) {
            entry.last = Instant::now();
            entry.written |= written;
            return Ok(entry.handle.clone());
        }
        drop(open);
        let handle = Arc::new(self.core.open(&self.path(id)?)?);
        if handle.is_dir {
            return Err(nfsstat3::NFS3ERR_ISDIR);
        }
        let mut open = lock(&self.open);
        let entry = open.entry(id).or_insert(Open { handle, last: Instant::now(), written });
        entry.written |= written;
        Ok(entry.handle.clone())
    }

    fn finish(&self, open: Open) {
        self.core.cleanup(&open.handle, false);
        self.core.close(&open.handle);
    }

    /// Upload (if written) and close a file's handle now.
    fn flush(&self, id: u64) {
        let taken = lock(&self.open).remove(&id);
        if let Some(open) = taken {
            self.finish(open);
        }
    }

    /// Close handles that have gone quiet: written ones upload.
    fn flush_idle(&self, all: bool) {
        let due: Vec<Open> = {
            let mut open = lock(&self.open);
            let ids: Vec<u64> = open
                .iter()
                .filter(|(_, o)| all || o.last.elapsed() >= if o.written { WRITE_IDLE } else { READ_IDLE })
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| open.remove(&id)).collect()
        };
        for open in due {
            self.finish(open);
        }
    }

    /// New files still being written are not on the server yet; list them too.
    fn pending_in(&self, dir: &str) -> Vec<(u64, Node, u64)> {
        lock(&self.open)
            .iter()
            .map(|(id, o)| (*id, o.handle.node(), o.handle.size()))
            .filter(|(_, n, _)| {
                n.id.is_none() && paths::parent(&n.path).map(|p| paths::key(&p)) == Some(paths::key(dir))
            })
            .collect()
    }

    fn lookup(&self, dir: u64, name: &filename3) -> Result<u64, nfsstat3> {
        match name.0.as_slice() {
            b"." => return Ok(dir),
            b".." => {
                let parent = paths::parent(&self.path(dir)?).unwrap_or_else(|| paths::ROOT.into());
                return Ok(lock(&self.ids).id(&parent));
            }
            _ => {}
        }
        let path = self.child(dir, name)?;
        let id = lock(&self.ids).id(&path);
        if lock(&self.open).contains_key(&id) || self.core.resolve(&path)?.is_some() {
            Ok(id)
        } else {
            Err(nfsstat3::NFS3ERR_NOENT)
        }
    }

    fn setattr(&self, id: u64, attr: sattr3) -> Result<fattr3, nfsstat3> {
        if let set_size3::size(size) = attr.size {
            let handle = self.handle(id, true)?;
            self.core.set_size(&handle, size)?;
        }
        self.getattr(id)
    }

    fn read(&self, id: u64, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        let handle = self.handle(id, false)?;
        let mut buf = vec![0u8; count as usize];
        match self.core.read(&handle, offset, &mut buf) {
            Ok(n) => {
                buf.truncate(n);
                Ok((buf, offset + n as u64 >= handle.size()))
            }
            Err(FsError::EndOfFile) => Ok((Vec::new(), true)),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, id: u64, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let handle = self.handle(id, true)?;
        self.core.write(&handle, offset, data, false, false)?;
        Ok(self.attr(id, &handle.node(), handle.size()))
    }

    /// Create a file, or truncate one that exists (NFS's unchecked create).
    fn create(&self, dir: u64, name: &filename3) -> Result<(u64, fattr3), nfsstat3> {
        let path = self.child(dir, name)?;
        let id = lock(&self.ids).id(&path);
        if self.core.resolve(&path)?.is_some() {
            let handle = self.handle(id, true)?;
            self.core.overwrite(&handle)?;
            return Ok((id, self.attr(id, &handle.node(), 0)));
        }
        let handle = Arc::new(self.core.create(&path, false)?);
        let node = handle.node();
        lock(&self.open).insert(id, Open { handle, last: Instant::now(), written: true });
        Ok((id, self.attr(id, &node, 0)))
    }

    fn mkdir(&self, dir: u64, name: &filename3) -> Result<(u64, fattr3), nfsstat3> {
        let path = self.child(dir, name)?;
        let handle = self.core.create(&path, true)?;
        let node = handle.node();
        let id = lock(&self.ids).id(&node.path);
        Ok((id, self.attr(id, &node, 0)))
    }

    fn remove(&self, dir: u64, name: &filename3) -> Result<(), nfsstat3> {
        let path = self.child(dir, name)?;
        let id = lock(&self.ids).id(&path);
        // A file deleted while still being written is dropped, never uploaded.
        let pending = lock(&self.open).remove(&id);
        if let Some(open) = &pending {
            self.core.close(&open.handle);
        }
        let handle = match self.core.open(&path) {
            Err(FsError::NotFound) if pending.is_some() => return Ok(()),
            other => other?,
        };
        if handle.is_dir {
            self.core.can_delete(&handle)?;
        }
        self.core.cleanup(&handle, true);
        self.core.close(&handle);
        Ok(())
    }

    fn rename(&self, from_dir: u64, from: &filename3, to_dir: u64, to: &filename3) -> Result<(), nfsstat3> {
        let (from, to) = (self.child(from_dir, from)?, self.child(to_dir, to)?);
        // Editors write a temporary file and rename it over the original: upload it first.
        let (id, replaced) = {
            let mut ids = lock(&self.ids);
            (ids.id(&from), ids.id(&to))
        };
        self.flush(id);
        // The file being replaced must not upload its old contents afterwards.
        let stale = if replaced == id { None } else { lock(&self.open).remove(&replaced) };
        if let Some(open) = stale {
            self.core.close(&open.handle);
        }
        self.core.rename(&from, &to)?;
        lock(&self.ids).rename(&from, &to);
        Ok(())
    }

    fn readdir(&self, dir: u64, start_after: u64, max: usize) -> Result<ReadDirResult, nfsstat3> {
        let path = self.path(dir)?;
        let folder = self.core.resolve(&path)?.ok_or(nfsstat3::NFS3ERR_NOENT)?;
        if !folder.is_folder {
            return Err(nfsstat3::NFS3ERR_NOTDIR);
        }
        let mut all: Vec<(u64, Node, u64)> = self
            .core
            .children(&folder)?
            .into_iter()
            .map(|c| {
                let size = c.size;
                (lock(&self.ids).id(&c.path), c, size)
            })
            .collect();
        for pending in self.pending_in(&path) {
            if !all.iter().any(|(id, _, _)| *id == pending.0) {
                all.push(pending);
            }
        }
        let start = if start_after == 0 {
            0
        } else {
            all.iter().position(|(id, _, _)| *id == start_after).map(|i| i + 1).unwrap_or(all.len())
        };
        let entries: Vec<DirEntry> = all[start..]
            .iter()
            .take(max)
            .map(|(id, node, size)| DirEntry {
                fileid: *id,
                name: node.name.as_bytes().to_vec().into(),
                attr: self.attr(*id, node, *size),
            })
            .collect();
        Ok(ReadDirResult { end: start + entries.len() >= all.len(), entries })
    }
}

/// Run a blocking core call off the async server: the core waits on the
/// network itself, which must not happen on the server's runtime threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, nfsstat3> + Send + 'static) -> Result<T, nfsstat3> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("cloud-drive-nfs".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?;
    rx.await.unwrap_or(Err(nfsstat3::NFS3ERR_SERVERFAULT))
}

#[derive(Clone)]
struct CloudNfs(Arc<Inner>);

#[async_trait]
impl NFSFileSystem for CloudNfs {
    fn capabilities(&self) -> VFSCapabilities {
        VFSCapabilities::ReadWrite
    }

    fn root_dir(&self) -> fileid3 {
        ROOT_ID
    }

    async fn lookup(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let (fs, name) = (self.0.clone(), filename3::from(filename.0.clone()));
        blocking(move || fs.lookup(dirid, &name)).await
    }

    async fn getattr(&self, id: fileid3) -> Result<fattr3, nfsstat3> {
        let fs = self.0.clone();
        blocking(move || fs.getattr(id)).await
    }

    async fn setattr(&self, id: fileid3, setattr: sattr3) -> Result<fattr3, nfsstat3> {
        let fs = self.0.clone();
        blocking(move || fs.setattr(id, setattr)).await
    }

    async fn read(&self, id: fileid3, offset: u64, count: u32) -> Result<(Vec<u8>, bool), nfsstat3> {
        let fs = self.0.clone();
        blocking(move || fs.read(id, offset, count)).await
    }

    async fn write(&self, id: fileid3, offset: u64, data: &[u8]) -> Result<fattr3, nfsstat3> {
        let (fs, data) = (self.0.clone(), data.to_vec());
        blocking(move || fs.write(id, offset, &data)).await
    }

    async fn create(&self, dirid: fileid3, filename: &filename3, _attr: sattr3) -> Result<(fileid3, fattr3), nfsstat3> {
        let (fs, name) = (self.0.clone(), filename3::from(filename.0.clone()));
        blocking(move || fs.create(dirid, &name)).await
    }

    async fn create_exclusive(&self, dirid: fileid3, filename: &filename3) -> Result<fileid3, nfsstat3> {
        let (fs, name) = (self.0.clone(), filename3::from(filename.0.clone()));
        blocking(move || fs.create(dirid, &name).map(|(id, _)| id)).await
    }

    async fn mkdir(&self, dirid: fileid3, dirname: &filename3) -> Result<(fileid3, fattr3), nfsstat3> {
        let (fs, name) = (self.0.clone(), filename3::from(dirname.0.clone()));
        blocking(move || fs.mkdir(dirid, &name)).await
    }

    async fn remove(&self, dirid: fileid3, filename: &filename3) -> Result<(), nfsstat3> {
        let (fs, name) = (self.0.clone(), filename3::from(filename.0.clone()));
        blocking(move || fs.remove(dirid, &name)).await
    }

    async fn rename(
        &self,
        from_dirid: fileid3,
        from_filename: &filename3,
        to_dirid: fileid3,
        to_filename: &filename3,
    ) -> Result<(), nfsstat3> {
        let fs = self.0.clone();
        let (from, to) = (filename3::from(from_filename.0.clone()), filename3::from(to_filename.0.clone()));
        blocking(move || fs.rename(from_dirid, &from, to_dirid, &to)).await
    }

    async fn readdir(
        &self,
        dirid: fileid3,
        start_after: fileid3,
        max_entries: usize,
    ) -> Result<ReadDirResult, nfsstat3> {
        let fs = self.0.clone();
        blocking(move || fs.readdir(dirid, start_after, max_entries)).await
    }

    async fn symlink(
        &self,
        _dirid: fileid3,
        _linkname: &filename3,
        _symlink: &nfspath3,
        _attr: &sattr3,
    ) -> Result<(fileid3, fattr3), nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }

    async fn readlink(&self, _id: fileid3) -> Result<nfspath3, nfsstat3> {
        Err(nfsstat3::NFS3ERR_NOTSUPP)
    }
}

/// The system's NFS client is always there on macOS; nothing to install.
pub fn is_available() -> bool {
    cfg!(target_os = "macos") || std::path::Path::new("/sbin/mount.nfs").exists()
}

/// The folder the drive appears at: "TMA Cloud" in the home folder.
pub fn default_mount_point() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("TMA Cloud"))
}

/// A mounted drive; dropping it uploads what is pending, unmounts and stops the server.
pub struct Mounted {
    pub mount_point: String,
    pub core: Arc<Core>,
    inner: Arc<Inner>,
    server: tokio::task::JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

impl Drop for Mounted {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.inner.flush_idle(true);
        if let Err(err) = unmount(&self.mount_point) {
            log::warn!("Cloud Drive unmount: {err}");
        }
        self.server.abort();
    }
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{cmd} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn unmount(point: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        run("/sbin/umount", &[point]).or_else(|_| run("/usr/sbin/diskutil", &["unmount", "force", point]))
    } else {
        run("umount", &[point])
    }
}

/// The mount command for a server on `port` (macOS's mount_nfs, or Linux's mount for tests).
fn mount_args(port: u16, point: &str) -> (String, Vec<String>) {
    let options = format!("nolocks,vers=3,tcp,rsize=131072,wsize=131072,actimeo=2,port={port},mountport={port}");
    if cfg!(target_os = "macos") {
        ("/sbin/mount_nfs".into(), vec!["-o".into(), options, "localhost:/".into(), point.into()])
    } else {
        let options = options.replace("nolocks", "nolock");
        ("mount".into(), vec!["-t".into(), "nfs".into(), "-o".into(), options, "127.0.0.1:/".into(), point.into()])
    }
}

pub fn mount(core: Arc<Core>, _label: &str, at: Option<&str>) -> Result<Mounted, String> {
    let point = match at {
        Some(p) => PathBuf::from(p),
        None => default_mount_point().ok_or("No home folder to mount TMA Cloud in")?,
    };
    std::fs::create_dir_all(&point).map_err(|e| format!("Cannot create {}: {e}", point.display()))?;
    let (uid, gid) = owner();
    let inner = Arc::new(Inner {
        core: core.clone(),
        ids: Mutex::new(IdTable::default()),
        open: Mutex::new(HashMap::new()),
        uid,
        gid,
    });
    // Only this computer can reach the server: NFSv3 has no authentication.
    let listener = tma_client::rt::block_on(NFSTcpListener::bind("127.0.0.1:0", CloudNfs(inner.clone())))
        .map_err(|e| format!("Cannot start the Cloud Drive server: {e}"))?;
    let port = listener.get_listen_port();
    let server = tma_client::rt::handle().spawn(async move {
        if let Err(err) = listener.handle_forever().await {
            log::warn!("Cloud Drive server stopped: {err}");
        }
    });
    let stop = Arc::new(AtomicBool::new(false));
    let (flusher, flag) = (inner.clone(), stop.clone());
    let _ = std::thread::Builder::new().name("cloud-drive-flush".into()).spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(500));
            flusher.flush_idle(false);
        }
    });
    let point_str = point.display().to_string();
    let (cmd, args) = mount_args(port, &point_str);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    if let Err(err) = run(&cmd, &args) {
        stop.store(true, Ordering::Relaxed);
        server.abort();
        return Err(format!("Cannot mount at {point_str}: {err}"));
    }
    Ok(Mounted { mount_point: point_str, core, inner, server, stop })
}

/// The user and group the files appear to belong to: whoever runs the app.
fn owner() -> (u32, u32) {
    let meta = std::env::var_os("HOME").and_then(|h| std::fs::metadata(h).ok());
    meta.map(|m| (m.uid(), m.gid())).unwrap_or((0, 0))
}
