//! The TMA Cloud API client. One `Client` serves the desktop app (reqwest with
//! its own cookie jar and the desktop header) and the web app (the browser's
//! fetch with the page's cookies); endpoint methods are split by domain.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod admin;
mod auth;
mod error;
pub mod events;
mod files;
mod http;
pub mod rt;
mod transfer;

pub use error::{ApiError, ApiResult};
pub use files::{ListQuery, Listing, View};
pub use http::{Client, device_id, set_device_id};
pub use transfer::{Progress, Source, UploadFile, UploadOptions};
