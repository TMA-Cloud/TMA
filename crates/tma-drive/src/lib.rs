//! Cloud Drive: TMA Cloud as a local drive. The core is platform independent;
//! WinFsp mounts it on Windows and FUSE on Linux and macOS.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod backend;
pub mod core;
pub mod paths;

#[cfg(all(windows, feature = "mount"))]
mod winfsp_fs;

pub use backend::{Backend, ClientBackend};
pub use core::{Core, FsError};

#[cfg(all(windows, feature = "mount"))]
pub use winfsp_fs::{Mounted, is_available, mount};

#[cfg(all(any(target_os = "linux", target_os = "macos"), feature = "mount"))]
mod fuse_fs;

#[cfg(all(any(target_os = "linux", target_os = "macos"), feature = "mount"))]
pub use fuse_fs::{Mounted, default_mount_point, is_available, mount};
