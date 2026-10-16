//! The router: URL to handler, plus the middleware each group needs. Handlers
//! parse the request, call a model or service, and shape the response.

mod admin;
mod auth;
mod files;
mod meta;
mod mfa;
mod onlyoffice;
mod public_share;
mod sessions;
mod spa;
mod subusers;

use axum::Router;
use axum::extract::{DefaultBodyLimit, FromRequest, Request, State};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::Response;
use axum::routing::{get, post};
use serde::de::DeserializeOwned;

use crate::auth::{AuthUser, require_auth};
use crate::error::ApiError;
use crate::middleware::{self as mw, ReqCtx};
use crate::services::limits;
use crate::state::AppState;

pub use meta::mark_started;

pub fn router(state: AppState) -> Router {
    let authed = Router::new()
        .merge(auth::authed_routes())
        .merge(sessions::routes())
        .merge(mfa::routes())
        .nest("/files", files::routes())
        .nest("/user", admin::routes().merge(subusers::routes()))
        .nest("/version", meta::version_routes())
        .route_layer(from_fn_with_state(state.clone(), api_limit))
        .route_layer(from_fn_with_state(state.clone(), require_auth));

    // A browser form post cannot send the CSRF header; it carries a ticket minted by a guarded request.
    let ticketed = Router::new()
        .route("/api/files/download/bulk/form", post(files::bulk_form))
        .route_layer(from_fn_with_state(state.clone(), api_limit))
        .route_layer(from_fn_with_state(state.clone(), require_auth));

    let api =
        Router::new().merge(meta::public_routes()).merge(auth::public_routes()).merge(authed).layer(from_fn(mw::csrf));

    Router::new()
        .route("/health", get(meta::health))
        .route("/metrics", get(meta::metrics))
        // The document server calls back without the CSRF header, so these routes guard themselves.
        .nest("/api/onlyoffice", onlyoffice::routes(state.clone()))
        .merge(ticketed)
        .nest("/api", api)
        .nest("/s", public_share::routes(state.clone()))
        .fallback(spa::serve)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(from_fn_with_state(state.clone(), mw::security_headers))
        .layer(from_fn_with_state(state.clone(), mw::desktop_only))
        .layer(from_fn_with_state(state.clone(), mw::share_domain))
        .layer(from_fn_with_state(state.clone(), mw::context))
        .with_state(state)
}

/// The general API budget: per user when signed in, per address otherwise.
async fn api_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let key = match req.extensions().get::<AuthUser>() {
        Some(auth) => format!("api:user:{}", auth.user_id),
        None => format!("api:{}", req.extensions().get::<ReqCtx>().and_then(|c| c.ip.clone()).unwrap_or_default()),
    };
    if let Err(limited) = state.limits.check(limits::API, &key) {
        return axum::response::IntoResponse::into_response(limited);
    }
    next.run(req).await
}

/// A JSON body whose rejection is the API's JSON error rather than plain text.
pub struct JsonBody<T>(pub T);

impl<S, T> FromRequest<S> for JsonBody<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let bytes =
            axum::body::Bytes::from_request(req, state).await.map_err(|e| ApiError::bad_request(e.body_text()))?;
        if bytes.is_empty() {
            return serde_json::from_slice(b"{}")
                .map(JsonBody)
                .map_err(|e| ApiError::bad_request(format!("Invalid request body: {e}")));
        }
        serde_json::from_slice(&bytes)
            .map(JsonBody)
            .map_err(|e| ApiError::validation("body", format!("Invalid request body: {e}")))
    }
}

/// `ids` from a body: 1-500 stored-item IDs.
pub fn require_ids(ids: &Option<Vec<String>>) -> Result<Vec<String>, ApiError> {
    const MAX: usize = 500;
    match ids {
        Some(ids) if !ids.is_empty() && ids.len() <= MAX => Ok(ids.clone()),
        _ => Err(ApiError::validation("ids", format!("File IDs must contain between 1 and {MAX} entries"))),
    }
}

/// An optional parent ID: absent or empty means the root, anything else must be an ID.
pub fn parent_id(raw: Option<&str>) -> Result<Option<String>, ApiError> {
    match raw.map(str::trim) {
        None | Some("") | Some("null") => Ok(None),
        Some(id) if crate::util::is_valid_id(id) => Ok(Some(id.to_string())),
        Some(_) => Err(ApiError::bad_request("Invalid parent ID")),
    }
}
