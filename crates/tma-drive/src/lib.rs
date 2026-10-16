//! Cloud Drive: TMA Cloud as a local drive. The core is platform independent;
//! WinFsp mounts it on Windows, FUSE on Linux and a local NFS server on macOS.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod backend;
pub mod core;
pub mod ids;
pub mod paths;

#[cfg(all(windows, feature = "mount"))]
mod winfsp_fs;

pub use backend::{Backend, ClientBackend};
pub use core::{Core, FsError};

#[cfg(all(windows, feature = "mount"))]
pub use winfsp_fs::{Mounted, is_available, mount};

#[cfg(all(target_os = "linux", feature = "mount"))]
mod fuse_fs;

#[cfg(all(target_os = "linux", feature = "mount"))]
pub use fuse_fs::{Mounted, default_mount_point, is_available, mount};

/// Public on Linux too, so the NFS adapter can be tested there.
#[cfg(all(unix, feature = "mount"))]
pub mod nfs_fs;

#[cfg(all(target_os = "macos", feature = "mount"))]
pub use nfs_fs::{Mounted, default_mount_point, is_available, mount};
