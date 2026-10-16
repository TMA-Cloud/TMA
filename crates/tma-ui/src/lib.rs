//! The TMA Cloud interface in egui, shared by the desktop app and the web app.
//! The shell supplies a `Host` for what differs between them.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod app;
mod auth;
pub mod cursors;
mod dashboard;
mod files;
mod host;
pub mod icons;
mod modals;
pub mod platform;
mod settings;
mod shell;
mod tasks;
pub mod theme;
mod toast;
pub mod transfers;
pub mod widgets;

pub use app::{App, Prefs};
pub use host::{Host, HostKind, SavedSession, WebHost};
pub use tasks::{Apply, Tasks};
pub use toast::Toasts;
