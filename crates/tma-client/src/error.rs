//! Errors as the UI shows them: the server's own message when it sent one.

use serde_json::Value;

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct ApiError {
    /// 0 when the request never reached the server.
    pub status: u16,
    pub message: String,
    /// The server's machine-readable `error` code, when present.
    pub code: Option<String>,
    pub body: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn network(err: impl std::fmt::Display) -> Self {
        Self { status: 0, message: format!("Cannot reach the server: {err}"), code: None, body: Value::Null }
    }

    pub fn local(message: impl Into<String>) -> Self {
        Self { status: 0, message: message.into(), code: None, body: Value::Null }
    }

    /// Build from a failed response body: a validation detail, then `message`, then `error`.
    pub fn from_body(status: u16, body: Value, fallback: &str) -> Self {
        // Validation details are `[{ "<field>": "<message>" }]`.
        let detail = body
            .get("details")
            .and_then(Value::as_array)
            .and_then(|d| d.first())
            .and_then(Value::as_object)
            .and_then(|d| d.values().find_map(Value::as_str));
        let message = detail
            .or_else(|| body.get("message").and_then(Value::as_str))
            .or_else(|| body.get("error").and_then(Value::as_str))
            .filter(|m| !m.is_empty())
            .unwrap_or(fallback)
            .to_string();
        let code = body.get("error").and_then(Value::as_str).map(String::from);
        Self { status, message, code, body }
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status == 401
    }

    pub fn needs_mfa(&self) -> bool {
        self.status == 400 && self.message == "MFA code required"
    }

    pub fn storage_not_configured(&self) -> bool {
        self.code.as_deref() == Some("STORAGE_NOT_CONFIGURED")
    }
}
