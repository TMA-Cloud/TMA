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

/// Body of every error response: `message`, plus an optional machine code.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorBody {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// express-validator style details: `[{ "field": "message" }]`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Vec<serde_json::Map<String, serde_json::Value>>>,
}

impl ErrorBody {
    /// The most specific human message: the first validation detail, then `message`, then `error`.
    pub fn best_message(&self) -> Option<String> {
        if let Some(first) = self.details.as_ref().and_then(|d| d.first())
            && let Some(text) = first.values().find_map(|v| v.as_str())
        {
            return Some(text.to_string());
        }
        if !self.message.is_empty() {
            return Some(self.message.clone());
        }
        self.error.clone()
    }
}

/// `{ "message": "..." }`, the plain success acknowledgement.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageResponse {
    pub message: String,
}

/// `{ "ok": true }`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct OkResponse {
    pub ok: bool,
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
    pub job_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
}

/// One line of an NDJSON progress stream (`Accept: application/x-ndjson`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProgressLine {
    Progress {
        done: usize,
        total: usize,
    },
    Done {
        #[serde(default)]
        message: Option<String>,
    },
    Error {
        message: String,
    },
}

/// Versions reported by `/api/version` and `/api/version/latest`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Versions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub electron: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<String>,
}
