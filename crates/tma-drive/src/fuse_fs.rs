//! The Linux adapter: FUSE requests translated to the core. FUSE
//! speaks in inode numbers, which the shared id table maps to paths.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use fuser::{
    Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, LockOwner, MountOption,
    OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen,
    ReplyStatfs, ReplyWrite, Request, TimeOrNow, WriteFlags,
};

use crate::core::{Core, FsError, Handle, Node};
use crate::ids::IdTable;
use crate::paths;

const TTL: Duration = Duration::from_secs(1);

impl From<FsError> for Errno {
    fn from(err: FsError) -> Self {
        match err {
            FsError::NotFound | FsError::PathNotFound => Errno::ENOENT,
            FsError::AccessDenied => Errno::EACCES,
            FsError::NotEmpty => Errno::ENOTEMPTY,
            FsError::EndOfFile => Errno::EIO,
            FsError::Io(msg) => {
                log::warn!("[drive] {msg}");
                Errno::EIO
            }
        }
    }
}

pub struct CloudFuse {
    core: Arc<Core>,
    inodes: Mutex<IdTable>,
    handles: Mutex<HashMap<u64, Arc<Handle>>>,
    next_fh: Mutex<u64>,
    uid: u32,
    gid: u32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn system_time(at: chrono::DateTime<chrono::Utc>) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_millis(at.timestamp_millis().max(0) as u64)
}

impl CloudFuse {
    fn attr(&self, ino: u64, node: &Node, size: u64) -> FileAttr {
        let modified = system_time(node.modified);
        FileAttr {
            ino: INodeNo(ino),
            size: if node.is_folder { 0 } else { size },
            blocks: size.div_ceil(512),
            atime: node.accessed.map(system_time).unwrap_or(modified),
            mtime: modified,
            ctime: modified,
            crtime: modified,
            kind: if node.is_folder { FileType::Directory } else { FileType::RegularFile },
            perm: if node.is_folder { 0o755 } else { 0o644 },
            nlink: 1,
            uid: self.uid,
            gid: self.gid,
            rdev: 0,
            blksize: 4096,
            flags: 0,
        }
    }

    fn path(&self, ino: INodeNo) -> Result<String, Errno> {
        lock(&self.inodes).path(ino.0).ok_or(Errno::ENOENT)
    }

    fn child(&self, parent: INodeNo, name: &OsStr) -> Result<String, Errno> {
        let name = name.to_str().ok_or(Errno::EINVAL)?;
        Ok(paths::join(&self.path(parent)?, name))
    }

    fn store(&self, handle: Handle) -> (u64, Arc<Handle>) {
        let mut next = lock(&self.next_fh);
        *next += 1;
        let handle = Arc::new(handle);
        lock(&self.handles).insert(*next, handle.clone());
        (*next, handle)
    }

    fn handle(&self, fh: FileHandle) -> Result<Arc<Handle>, Errno> {
        lock(&self.handles).get(&fh.0).cloned().ok_or(Errno::EBADF)
    }

    fn entry_for(&self, path: &str) -> Result<FileAttr, Errno> {
        let node = self.core.resolve(path)?.ok_or(Errno::ENOENT)?;
        let ino = lock(&self.inodes).id(&node.path);
        Ok(self.attr(ino, &node, node.size))
    }

    /// Delete the item at `path` (to the trash), refusing a non-empty folder for rmdir.
    fn remove(&self, path: &str, folder: bool) -> Result<(), Errno> {
        let handle = self.core.open(path)?;
        if folder {
            self.core.can_delete(&handle)?;
        }
        self.core.cleanup(&handle, true);
        self.core.close(&handle);
        Ok(())
    }
}

impl Filesystem for CloudFuse {
    fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        match self.child(parent, name).and_then(|p| self.entry_for(&p)) {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn getattr(&self, _req: &Request, ino: INodeNo, fh: Option<FileHandle>, reply: ReplyAttr) {
        if let Some(handle) = fh.and_then(|fh| self.handle(fh).ok()) {
            return reply.attr(&TTL, &self.attr(ino.0, &handle.node(), handle.size()));
        }
        match self.path(ino).and_then(|p| self.entry_for(&p)) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn setattr(
        &self,
        _req: &Request,
        ino: INodeNo,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        let result = (|| -> Result<FileAttr, Errno> {
            let Some(size) = size else { return self.path(ino).and_then(|p| self.entry_for(&p)) };
            // A truncate without an open handle (truncate(2)) opens, resizes and saves.
            let (handle, temporary) = match fh.and_then(|fh| self.handle(fh).ok()) {
                Some(h) => (h, false),
                None => (Arc::new(self.core.open(&self.path(ino)?)?), true),
            };
            self.core.set_size(&handle, size)?;
            if temporary {
                self.core.cleanup(&handle, false);
                self.core.close(&handle);
            }
            Ok(self.attr(ino.0, &handle.node(), size))
        })();
        match result {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(e) => reply.error(e),
        }
    }

    fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
        let result = self.child(parent, name).and_then(|path| {
            let handle = self.core.create(&path, true)?;
            let node = handle.node();
            let ino = lock(&self.inodes).id(&node.path);
            Ok(self.attr(ino, &node, 0))
        });
        match result {
            Ok(attr) => reply.entry(&TTL, &attr, Generation(0)),
            Err(e) => reply.error(e),
        }
    }

    fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.child(parent, name).and_then(|p| self.remove(&p, false)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        match self.child(parent, name).and_then(|p| self.remove(&p, true)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn rename(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        newparent: INodeNo,
        newname: &OsStr,
        _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        let result = (|| -> Result<(), Errno> {
            let (from, to) = (self.child(parent, name)?, self.child(newparent, newname)?);
            self.core.rename(&from, &to)?;
            lock(&self.inodes).rename(&from, &to);
            Ok(())
        })();
        match result {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(e),
        }
    }

    fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        let result = self.path(ino).and_then(|path| {
            let handle = self.core.open(&path)?;
            if flags.0 & libc::O_TRUNC != 0 {
                self.core.overwrite(&handle)?;
            }
            Ok(self.store(handle).0)
        });
        match result {
            Ok(fh) => reply.opened(FileHandle(fh), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }

    fn read(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock: Option<LockOwner>,
        reply: ReplyData,
    ) {
        let result = self.handle(fh).and_then(|h| {
            let mut buf = vec![0u8; size as usize];
            match self.core.read(&h, offset, &mut buf) {
                Ok(n) => {
                    buf.truncate(n);
                    Ok(buf)
                }
                Err(FsError::EndOfFile) => Ok(Vec::new()),
                Err(e) => Err(e.into()),
            }
        });
        match result {
            Ok(data) => reply.data(&data),
            Err(e) => reply.error(e),
        }
    }

    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        data: &[u8],
        _wf: WriteFlags,
        flags: OpenFlags,
        _lock: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        let append = flags.0 & libc::O_APPEND != 0;
        match self.handle(fh).and_then(|h| self.core.write(&h, offset, data, append, false).map_err(Errno::from)) {
            Ok(n) => reply.written(n as u32),
            Err(e) => reply.error(e),
        }
    }

    fn flush(&self, _req: &Request, _ino: INodeNo, _fh: FileHandle, _lock: LockOwner, reply: ReplyEmpty) {
        reply.ok();
    }

    fn release(
        &self,
        _req: &Request,
        _ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        if let Some(handle) = lock(&self.handles).remove(&fh.0) {
            self.core.cleanup(&handle, false);
            self.core.close(&handle);
        }
        reply.ok();
    }

    fn opendir(&self, _req: &Request, _ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
        reply.opened(FileHandle(0), FopenFlags::empty());
    }

    fn readdir(&self, _req: &Request, ino: INodeNo, _fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
        let result = (|| -> Result<Vec<(u64, FileType, String)>, Errno> {
            let path = self.path(ino)?;
            let folder = self.core.resolve(&path)?.ok_or(Errno::ENOENT)?;
            let parent_ino = paths::parent(&path).map(|p| lock(&self.inodes).id(&p)).unwrap_or(ino.0);
            let mut entries = vec![
                (ino.0, FileType::Directory, ".".to_string()),
                (parent_ino, FileType::Directory, "..".to_string()),
            ];
            for child in self.core.children(&folder)? {
                let child_ino = lock(&self.inodes).id(&child.path);
                entries.push((
                    child_ino,
                    if child.is_folder { FileType::Directory } else { FileType::RegularFile },
                    child.name,
                ));
            }
            Ok(entries)
        })();
        match result {
            Ok(entries) => {
                for (i, (ino, kind, name)) in entries.into_iter().enumerate().skip(offset as usize) {
                    if reply.add(INodeNo(ino), (i + 1) as u64, kind, name) {
                        break;
                    }
                }
                reply.ok();
            }
            Err(e) => reply.error(e),
        }
    }

    fn create(
        &self,
        _req: &Request,
        parent: INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        let result = self.child(parent, name).and_then(|path| {
            let handle = self.core.create(&path, false)?;
            let node = handle.node();
            let ino = lock(&self.inodes).id(&node.path);
            let attr = self.attr(ino, &node, 0);
            Ok((self.store(handle).0, attr))
        });
        match result {
            Ok((fh, attr)) => reply.created(&TTL, &attr, Generation(0), FileHandle(fh), FopenFlags::empty()),
            Err(e) => reply.error(e),
        }
    }

    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        let (total, free) = self.core.space();
        reply.statfs(total / 4096, free / 4096, free / 4096, 0, 0, 4096, 255, 4096);
    }
}

/// Whether FUSE is usable here (the device and the mount helper exist).
pub fn is_available() -> bool {
    Path::new("/dev/fuse").exists()
}

/// A mounted drive; dropping it unmounts.
pub struct Mounted {
    _session: fuser::BackgroundSession,
    pub mount_point: String,
    pub core: Arc<Core>,
}

/// The folder the drive appears at: "TMA Cloud" in the home folder.
pub fn default_mount_point() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("TMA Cloud"))
}

pub fn mount(core: Arc<Core>, label: &str, at: Option<&str>) -> Result<Mounted, String> {
    let point = match at {
        Some(p) => PathBuf::from(p),
        None => default_mount_point().ok_or("No home folder to mount TMA Cloud in")?,
    };
    std::fs::create_dir_all(&point).map_err(|e| format!("Cannot create {}: {e}", point.display()))?;
    let meta = std::fs::metadata(&point).map_err(|e| e.to_string())?;
    let fs = CloudFuse {
        core: core.clone(),
        inodes: Mutex::new(IdTable::default()),
        handles: Mutex::new(HashMap::new()),
        next_fh: Mutex::new(0),
        uid: meta.uid(),
        gid: meta.gid(),
    };
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName("tma-cloud".into()),
        MountOption::Subtype(label.to_lowercase().replace(' ', "-")),
        MountOption::DefaultPermissions,
    ];
    let session =
        fuser::spawn_mount(fs, &point, &config).map_err(|e| format!("Cannot mount at {}: {e}", point.display()))?;
    Ok(Mounted { _session: session, mount_point: point.display().to_string(), core })
}
