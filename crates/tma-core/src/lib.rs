//! Shared, platform-free building blocks for TMA Cloud. Nothing here touches
//! the network, the file system or a clock beyond `chrono::Utc::now`, so the
//! same code runs in the server, the desktop app and the browser build.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod api;
pub mod format;
pub mod kind;
pub mod names;
pub mod permissions;

pub use kind::{FileKind, file_kind};
pub use permissions::Permission;

/// Header every desktop build sends, so an instance can be limited to the app.
pub const DESKTOP_HEADER_NAME: &str = "X-TMA-Desktop-Client";
/// Value of [`DESKTOP_HEADER_NAME`]; unchanged from the Electron app so admin settings keep working.
pub const DESKTOP_HEADER_VALUE: &str = "tma-electron-client-v1";

/// Product name shown in titles and the About page.
pub const PRODUCT_NAME: &str = "TMA Cloud";
