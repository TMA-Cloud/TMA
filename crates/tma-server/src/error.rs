//! One error type for every handler. It renders the JSON body the API has
//! always used: `{ message, error?, ...extra }`, with full details in the logs.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub code: Option<&'static str>,
    pub extra: Map<String, Value>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), code: None, extra: Map::new() }
    }

    pub fn code(mut self, code: &'static str) -> Self {
        self.code = Some(code);
        self
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    pub fn too_many(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }

    /// 422 with express-validator style details, so clients show the first one.
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        let mut detail = Map::new();
        detail.insert(field.to_string(), Value::String(message));
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, "Validation failed")
            .with("details", Value::Array(vec![Value::Object(detail)]))
    }

    pub fn storage_not_configured() -> Self {
        Self::unavailable("Storage is not configured. The administrator must connect a storage bucket in Settings.")
            .code("STORAGE_NOT_CONFIGURED")
    }

    pub fn storage_limit(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message).code("STORAGE_LIMIT_EXCEEDED")
    }

    /// An unexpected failure: logged in full, reported generically.
    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!(error = %err, "Error in request handler");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Server error").code("INTERNAL_ERROR")
    }

    /// The same failure with a handler-specific message.
    pub fn internal_msg(message: &str, err: impl std::fmt::Display) -> Self {
        tracing::error!(error = %err, "{message}");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message).code("INTERNAL_ERROR")
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status.as_u16(), self.message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        body.insert("message".into(), Value::String(self.message));
        if let Some(code) = self.code {
            body.insert("error".into(), Value::String(code.into()));
        }
        body.extend(self.extra);
        (self.status, Json(Value::Object(body))).into_response()
    }
}

/// Errors the domain layer raises that map to a specific status.
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("Storage is not configured")]
    StorageNotConfigured,
    #[error("Storage limit exceeded")]
    StorageLimit,
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Conflict(String),
}

impl From<DomainError> for ApiError {
    fn from(err: DomainError) -> Self {
        match err {
            DomainError::StorageNotConfigured => ApiError::storage_not_configured(),
            DomainError::StorageLimit => ApiError::storage_limit("Storage limit exceeded"),
            DomainError::NotFound(m) => ApiError::not_found(m),
            DomainError::BadRequest(m) => ApiError::bad_request(m),
            DomainError::Forbidden(m) => ApiError::forbidden(m),
            DomainError::Conflict(m) => ApiError::conflict(m),
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        if let sqlx::Error::Database(db) = &err {
            match db.code().as_deref() {
                Some("23505") => return ApiError::conflict("Resource already exists").code("DUPLICATE_RESOURCE"),
                Some("23503") => return ApiError::bad_request("Invalid reference").code("INVALID_REFERENCE"),
                _ => {}
            }
        }
        ApiError::internal(err)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        // A domain error raised deep inside keeps its status.
        match err.downcast::<DomainError>() {
            Ok(domain) => domain.into(),
            Err(err) => match err.downcast::<ApiError>() {
                Ok(api) => api,
                Err(err) => ApiError::internal(format!("{err:#}")),
            },
        }
    }
}

impl std::error::Error for ApiError {}

/// `{ message }` with a 200.
pub fn message(text: impl Into<String>) -> Json<Value> {
    Json(json!({ "message": text.into() }))
}
