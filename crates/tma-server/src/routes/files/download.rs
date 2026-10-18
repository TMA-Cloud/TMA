//! Downloads: one file (Range-aware, decrypted on the fly), or folders and
//! selections as a streamed ZIP.

use axum::Json;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};
use tma_core::Permission;

use crate::auth::{self, AuthUser, jwt};
use crate::error::{ApiError, ApiResult};
use crate::middleware::ReqCtx;
use crate::models::files::{archive, crud};
use crate::routes::{JsonBody, require_ids};
use crate::services::audit::Event;
use crate::state::AppState;
use crate::transfer::{download, zip};

#[derive(Deserialize)]
pub struct DownloadQuery {
    inline: Option<String>,
}

pub async fn single(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<DownloadQuery>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    auth::require(&state, &auth, &ctx, Permission::Download).await?;
    let file =
        crud::get(&state.pool, &id, &auth.owner_id).await?.ok_or_else(|| ApiError::not_found("File not found"))?;
    if file.is_folder() {
        let entries = archive::owner_entries(
            state.pool.clone(),
            vec![id.clone()],
            auth.owner_id.clone(),
            state.config.held_cursor_limit,
        );
        let (access, owner, reader) = (state.access.clone(), auth.owner_id.clone(), auth.user_id.clone());
        state.audit.log(
            &ctx,
            Event::new("folder.download").resource("folder", Some(&id)).meta(json!({ "folderName": file.name })),
        );
        return zip::response(&state, &file.name, entries, move |entry| {
            access.record_one(&entry.id, &owner, Some(&reader))
        });
    }
    state
        .audit
        .log(&ctx, Event::new("file.download").resource("file", Some(&id)).meta(json!({ "fileName": file.name })));
    state.access.record_one(&id, &auth.owner_id, Some(&auth.user_id));
    // Inline only for images that cannot run script; everything else is an attachment.
    let image = file.mime_type.as_deref().is_some_and(|m| m.starts_with("image/"));
    let inline = q.inline.as_deref() == Some("1") && image && !download::requires_download(&file.name);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    download::serve(&state, &file, range, inline).await
}

/// A browser saves a ticketed download with its own download manager, so a large ZIP streams to disk.
const TICKET_PURPOSE: &str = "bulk-download";
const TICKET_SECONDS: i64 = 60;

#[derive(Deserialize)]
pub struct BulkBody {
    ids: Option<Vec<String>>,
}

pub async fn bulk(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<BulkBody>,
) -> ApiResult<Response> {
    stream_selection(&state, &ctx, &auth, &body.ids).await
}

/// Mint a one-minute ticket for `bulk_form`; the request carries the CSRF header, the form post cannot.
pub async fn bulk_ticket(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<BulkBody>,
) -> ApiResult<Json<Value>> {
    auth::require(&state, &auth, &ctx, Permission::Download).await?;
    let ids = require_ids(&body.ids)?;
    if crud::get_many(&state.pool, &ids, &auth.owner_id).await?.is_empty() {
        return Err(ApiError::not_found("No files found to download"));
    }
    let claims = json!({
        "purpose": TICKET_PURPOSE, "ids": ids, "userId": auth.user_id, "ownerId": auth.owner_id,
        "sessionId": auth.session_id, "exp": chrono::Utc::now().timestamp() + TICKET_SECONDS,
    });
    let ticket = jwt::sign_value(&state.config.jwt_secret, &claims)?;
    Ok(Json(json!({ "ticket": ticket, "expiresIn": TICKET_SECONDS })))
}

#[derive(Deserialize)]
pub struct TicketForm {
    ticket: String,
}

/// The browser's form post for a ticket; outside the CSRF layer, so the ticket must match this session.
pub async fn bulk_form(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Form(form): Form<TicketForm>,
) -> ApiResult<Response> {
    let claims = jwt::verify_value(&state.config.jwt_secret, &form.ticket, true)
        .filter(|c| {
            c["purpose"] == TICKET_PURPOSE
                && c["userId"] == auth.user_id.as_str()
                && c["ownerId"] == auth.owner_id.as_str()
                && c["sessionId"] == json!(auth.session_id)
        })
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "This download link has expired. Try again."))?;
    let ids: Option<Vec<String>> = serde_json::from_value(claims["ids"].clone()).ok();
    stream_selection(&state, &ctx, &auth, &ids).await
}

/// Several items as one streamed ZIP, named after the item when there is only one.
async fn stream_selection(
    state: &AppState,
    ctx: &ReqCtx,
    auth: &AuthUser,
    ids: &Option<Vec<String>>,
) -> ApiResult<Response> {
    auth::require(state, auth, ctx, Permission::Download).await?;
    let ids = require_ids(ids)?;
    let files = crud::get_many(&state.pool, &ids, &auth.owner_id).await?;
    if files.is_empty() {
        return Err(ApiError::not_found("No files found to download"));
    }
    let name = if files.len() == 1 {
        files[0].name.clone()
    } else {
        format!("download_{}", chrono::Utc::now().timestamp_millis())
    };
    let roots: Vec<String> = files.iter().map(|f| f.id.clone()).collect();
    state.audit.log(
        ctx,
        Event::new("file.download.bulk").resource("file", ids.first().map(String::as_str)).meta(json!({
            "fileCount": ids.len(), "fileIds": ids, "fileNames": files.iter().map(|f| f.name.clone()).collect::<Vec<_>>(),
        })),
    );
    let entries =
        archive::owner_entries(state.pool.clone(), roots, auth.owner_id.clone(), state.config.held_cursor_limit);
    let (access, owner, reader) = (state.access.clone(), auth.owner_id.clone(), auth.user_id.clone());
    zip::response(state, &name, entries, move |entry| access.record_one(&entry.id, &owner, Some(&reader)))
}
