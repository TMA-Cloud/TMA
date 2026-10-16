//! `/s/{token}`: what anyone with a share link sees. Folders render as a plain
//! HTML listing (or JSON for clients that ask), files as a landing page, and
//! downloads stream straight from the bucket.

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::from_fn_with_state;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;

use crate::middleware::ReqCtx;
use crate::models::files::archive;
use crate::models::shares::{self, SharedRoot, TokenLookup};
use crate::pages::share as pages;
use crate::services::audit::Event;
use crate::state::AppState;
use crate::transfer::{download, zip};
use crate::util::is_valid_id;

pub fn routes(state: AppState) -> Router<AppState> {
    Router::new()
        .route("/{token}", get(root))
        .route("/{token}/folder/{id}", get(folder))
        .route("/{token}/file/{id}", get(item))
        .route("/{token}/zip", get(root_zip))
        .route_layer(from_fn_with_state(state, super::api_limit))
}

fn error_page(status: StatusCode, title: &str, message: &str) -> Response {
    (status, Html(pages::error_page(title, message))).into_response()
}

fn server_error(err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "Share link error");
    error_page(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong", "Please try again in a moment.")
}

fn not_found() -> Response {
    error_page(StatusCode::NOT_FOUND, "Not found", "The requested item was not found in this share.")
}

/// Share tokens are generated IDs; anything else cannot exist.
async fn resolve(state: &AppState, token: &str) -> Result<SharedRoot, Box<Response>> {
    let missing = || {
        Box::new(error_page(
            StatusCode::NOT_FOUND,
            "Link not found",
            "This share link does not exist or has been removed.",
        ))
    };
    if !is_valid_id(token) {
        return Err(missing());
    }
    match shares::by_token(&state.pool, &state.cache, token).await {
        Ok(TokenLookup::Found(root)) => Ok(root),
        Ok(TokenLookup::Expired) => Err(Box::new(error_page(
            StatusCode::GONE,
            "Link expired",
            "This share link has expired and is no longer available.",
        ))),
        Ok(TokenLookup::Missing) => Err(missing()),
        Err(err) => Err(Box::new(server_error(err))),
    }
}

fn prefers_json(headers: &HeaderMap) -> bool {
    let accept = headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).unwrap_or("");
    accept.contains("application/json") && !accept.contains("text/html")
}

#[derive(Deserialize)]
pub struct PageQuery {
    cursor: Option<String>,
    limit: Option<String>,
}

/// `view` is the heading, breadcrumb trail and ZIP link of the page.
async fn listing(
    state: &AppState,
    token: &str,
    folder_id: &str,
    q: &PageQuery,
    headers: &HeaderMap,
    view: (&str, &[(String, String)], &str),
) -> Response {
    let (heading, trail, zip_href) = view;
    let limit = q.limit.as_deref().and_then(|l| l.parse().ok());
    match shares::folder_page(&state.pool, token, folder_id, q.cursor.as_deref(), limit).await {
        Ok(page) if prefers_json(headers) => axum::Json(page).into_response(),
        Ok(page) => Html(pages::folder_page(&page, token, heading, trail, zip_href)).into_response(),
        Err(err) => server_error(err),
    }
}

pub async fn root(
    State(state): State<AppState>,
    ctx: ReqCtx,
    Path(token): Path<String>,
    Query(q): Query<PageQuery>,
    headers: HeaderMap,
) -> Response {
    let root = match resolve(&state, &token).await {
        Ok(root) => root,
        Err(page) => return *page,
    };
    state.audit.log(&ctx, Event::new("share.access").resource("share", Some(&token)));
    // A visitor is still a reader, so the owner's item counts as accessed.
    state.access.record_one(&root.id, &root.user_id);
    tracing::info!(share_token = %token, file_id = %root.id, "Share link accessed");
    if root.item_type == "folder" {
        let trail = [(root.id.clone(), root.name.clone())];
        return listing(&state, &token, &root.id, &q, &headers, (&root.name, &trail, &format!("/s/{token}/zip"))).await;
    }
    Html(pages::file_page(&token, &root.id, &root.name, root.mime_type.as_deref(), root.size.unwrap_or(0)))
        .into_response()
}

pub async fn folder(
    State(state): State<AppState>,
    ctx: ReqCtx,
    Path((token, id)): Path<(String, String)>,
    Query(q): Query<PageQuery>,
    headers: HeaderMap,
) -> Response {
    let root = match resolve(&state, &token).await {
        Ok(root) => root,
        Err(page) => return *page,
    };
    if !is_valid_id(&id) {
        return not_found();
    }
    // The breadcrumb doubles as the membership check: no trail, not in this share.
    let trail = match shares::folder_trail(&state.pool, &token, &id).await {
        Ok(trail) => trail,
        Err(err) => return server_error(err),
    };
    let Some((_, name, kind)) = trail.last().cloned() else { return not_found() };
    if kind != "folder" {
        return not_found();
    }
    state.audit.log(&ctx, Event::new("share.access").resource("share", Some(&token)));
    state.access.record_one(&id, &root.user_id);
    let crumbs: Vec<(String, String)> = trail.into_iter().map(|(id, name, _)| (id, name)).collect();
    listing(&state, &token, &id, &q, &headers, (&name, &crumbs, &format!("/s/{token}/file/{id}"))).await
}

fn zip_folder(state: &AppState, token: &str, folder_id: &str, name: &str, owner: &str) -> Response {
    let entries = archive::shared_entries(
        state.pool.clone(),
        token.to_string(),
        folder_id.to_string(),
        state.config.held_cursor_limit,
    );
    let (access, owner) = (state.access.clone(), owner.to_string());
    match zip::response(state, name, entries, move |entry| access.record_one(&entry.id, &owner)) {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}

pub async fn root_zip(State(state): State<AppState>, ctx: ReqCtx, Path(token): Path<String>) -> Response {
    let root = match resolve(&state, &token).await {
        Ok(root) => root,
        Err(page) => return *page,
    };
    if root.item_type != "folder" {
        return error_page(StatusCode::NOT_FOUND, "Not found", "The requested resource was not found.");
    }
    state.audit.log(
        &ctx,
        Event::new("share.download")
            .resource("share", Some(&token))
            .meta(json!({ "fileName": root.name, "downloadType": "zip" })),
    );
    zip_folder(&state, &token, &root.id, &root.name, &root.user_id)
}

pub async fn item(
    State(state): State<AppState>,
    ctx: ReqCtx,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let root = match resolve(&state, &token).await {
        Ok(root) => root,
        Err(page) => return *page,
    };
    if !is_valid_id(&id) {
        return not_found();
    }
    // One query both finds the item and proves it belongs to this share.
    let file = match shares::member(&state.pool, &token, &id).await {
        Ok(Some(file)) => file,
        Ok(None) => return not_found(),
        Err(err) => return server_error(err),
    };
    state.audit.log(
        &ctx,
        Event::new("share.download")
            .resource("share", Some(&token))
            .meta(json!({ "fileName": file.name, "fileId": id, "fileType": file.item_type })),
    );
    if file.is_folder() {
        return zip_folder(&state, &token, &id, &file.name, &root.user_id);
    }
    state.access.record_one(&file.id, &root.user_id);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match download::serve(&state, &file, range, false).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
