//! Listings, search, dashboard counts, Get Info and background job status.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use tma_core::api::{FileInfo, FileItem, FileStats, SortBy, SortOrder};

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::jobs::queues;
use crate::models::files::listing::{self, View};
use crate::models::files::{Keyset, Page};
use crate::state::AppState;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    parent_id: Option<String>,
    sort_by: Option<String>,
    order: Option<String>,
    cursor: Option<String>,
    limit: Option<String>,
}

impl ListQuery {
    fn keyset(&self, default_sort: SortBy) -> Keyset {
        Keyset::new(
            self.sort_by.as_deref().and_then(SortBy::parse).unwrap_or(default_sort),
            self.order.as_deref().and_then(SortOrder::parse).unwrap_or(SortOrder::Desc),
            self.cursor.as_deref(),
            self.limit.as_deref().and_then(|l| l.parse().ok()),
        )
    }
}

/// A page as a JSON array, the next cursor in `X-Next-Cursor`, never cached.
fn page_response(page: Page) -> Response {
    let mut headers = HeaderMap::new();
    if let Some(cursor) = page.next_cursor.as_deref().and_then(|c| HeaderValue::from_str(c).ok()) {
        headers.insert("x-next-cursor", cursor);
    }
    headers.insert("cache-control", HeaderValue::from_static("no-store, no-cache, must-revalidate, proxy-revalidate"));
    headers.insert("pragma", HeaderValue::from_static("no-cache"));
    headers.insert("expires", HeaderValue::from_static("0"));
    (headers, Json(page.files)).into_response()
}

pub async fn folder(State(state): State<AppState>, auth: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Response> {
    let parent = super::super::parent_id(q.parent_id.as_deref())?;
    let page = listing::list(&state.pool, &auth.owner_id, View::Folder(parent.as_deref()), &q.keyset(SortBy::Modified))
        .await?;
    // The directory counts as accessed, not its children (the root is not a row).
    if let Some(p) = &parent {
        state.access.record_one(p, &auth.owner_id, Some(&auth.user_id));
    }
    Ok(page_response(page))
}

pub async fn starred(State(state): State<AppState>, auth: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Response> {
    Ok(page_response(listing::list(&state.pool, &auth.owner_id, View::Starred, &q.keyset(SortBy::Modified)).await?))
}

pub async fn shared(State(state): State<AppState>, auth: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Response> {
    Ok(page_response(listing::list(&state.pool, &auth.owner_id, View::Shared, &q.keyset(SortBy::Modified)).await?))
}

pub async fn trash(State(state): State<AppState>, auth: AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Response> {
    Ok(page_response(listing::list_trash(&state.pool, &auth.owner_id, &q.keyset(SortBy::DeletedAt)).await?))
}

pub async fn stats(State(state): State<AppState>, auth: AuthUser) -> ApiResult<Json<FileStats>> {
    Ok(Json(listing::stats(&state.pool, &auth.owner_id).await?))
}

pub async fn info(State(state): State<AppState>, auth: AuthUser, Path(id): Path<String>) -> ApiResult<Json<FileInfo>> {
    Ok(Json(listing::info(&state.pool, &id, &auth.owner_id).await?))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    query: Option<String>,
    limit: Option<String>,
}

pub async fn search(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<FileItem>>> {
    let raw = q.q.or(q.query).unwrap_or_default();
    let term: String = raw.trim().chars().filter(|c| !c.is_control()).collect();
    if term.is_empty() || raw.trim().chars().count() > 200 {
        return Err(ApiError::bad_request("Invalid search query"));
    }
    let limit = q.limit.and_then(|l| l.parse::<i64>().ok()).filter(|l| (1..=100).contains(l)).unwrap_or(100);
    Ok(Json(listing::search(&state.pool, &auth.owner_id, &term, limit).await?))
}

#[derive(Deserialize)]
pub struct RecentQuery {
    limit: Option<String>,
}

pub async fn recent(
    State(state): State<AppState>,
    auth: AuthUser,
    Query(q): Query<RecentQuery>,
) -> ApiResult<Json<Vec<FileItem>>> {
    let limit = q.limit.and_then(|l| l.parse::<i64>().ok()).filter(|l| (1..=50).contains(l)).unwrap_or(10);
    Ok(Json(listing::recent(&state.pool, &auth.owner_id, limit).await?))
}

pub async fn job(State(state): State<AppState>, auth: AuthUser, Path(job_id): Path<String>) -> ApiResult<Response> {
    let id = uuid::Uuid::parse_str(&job_id).map_err(|_| ApiError::bad_request("Invalid background job ID"))?;
    let job = state.jobs.get(queues::FILE_OPERATIONS, id).await?;
    let job = job
        .filter(|j| j.data.get("userId").and_then(|v| v.as_str()) == Some(auth.owner_id.as_str()))
        .ok_or_else(|| ApiError::not_found("Background file job not found"))?;
    match job.state.as_str() {
        "failed" | "cancelled" => {
            Err(ApiError::internal_msg("Background file operation failed", job.error.unwrap_or_default()))
        }
        "completed" => {
            Ok(Json(json!({ "jobId": job.id, "status": job.state, "result": job.output.unwrap_or_else(|| json!({})) }))
                .into_response())
        }
        _ => Ok((StatusCode::ACCEPTED, Json(json!({ "jobId": job.id, "status": job.state }))).into_response()),
    }
}
