//! Wire types for the REST API. The server serialises these and every client
//! parses them, so a field renamed here is renamed everywhere. Field names keep
//! the JSON the API has always returned (mixed camelCase and snake_case).

mod admin;
mod auth;
mod files;

pub use admin::*;
pub use auth::*;
pub use files::*;

use serde::{Deserialize, Serialize};

/// `{ "message": "..." }`, the plain success acknowledgement.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageResponse {
    pub message: String,
}

/// A background job handed to the worker: `202 { message, queued, jobId }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedResponse {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub queued: bool,
    #[serde(default)]
    pub job_id: Option<String>,
}

/// State of a queued job: `202 { jobId, status }` until done, then `200 { jobId, status, result }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub status: String,
}

/// Versions reported by `/api/version` and `/api/version/latest`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Versions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,
}
