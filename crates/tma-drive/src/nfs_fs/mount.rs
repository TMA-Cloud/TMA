//! Mounting the local NFS server with the system client, and unmounting it.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nfsserve::tcp::{NFSTcp, NFSTcpListener};

use super::{CloudNfs, Inner};
use crate::core::Core;
use crate::ids::IdTable;

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
