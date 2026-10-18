//! TMA Cloud server library: the API, the background worker and admin tasks
//! share these modules; `main.rs` only picks which one to run.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![cfg_attr(test, expect(clippy::unwrap_used, clippy::expect_used, reason = "tests fail loudly on purpose"))]

pub mod auth;
pub mod cache;
pub mod cli;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod jobs;
pub mod middleware;
pub mod models;
pub mod pages;
pub mod routes;
pub mod server;
pub mod services;
pub mod settings;
pub mod state;
pub mod storage;
pub mod transfer;
pub mod util;
