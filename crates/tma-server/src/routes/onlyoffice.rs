//! `/api/onlyoffice`: the editor config and viewer page for signed-in users, a
//! one-minute ticket the desktop app opens in the system browser, and the two
//! endpoints the document server calls (file fetch and save callback).

use axum::extract::{DefaultBodyLimit, Extension, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tma_core::Permission;

use crate::auth::{self, AuthUser, jwt, require_auth};
use crate::error::{ApiError, ApiResult};
use crate::middleware::{CspNonce, ReqCtx, csrf};
use crate::models::files::crud::{self, StoredFile};
use crate::models::users;
use crate::pages::viewer;
use crate::services::audit::Event;
use crate::services::onlyoffice::{self as oo, SaveOutcome, SessionRequest};
use crate::state::AppState;
use crate::transfer::download;
use crate::util::is_valid_id;

const NOT_CONFIGURED: &str = "OnlyOffice integration not configured. Configure it in Settings.";
const TICKET_PURPOSE: &str = "onlyoffice-open";
const TICKET_SECONDS: i64 = 60;

pub fn routes(state: AppState) -> Router<AppState> {
    let authed = Router::new()
        .route("/config/{id}", get(config))
        .route("/viewer/{id}", get(viewer_page))
        .route("/ticket/{id}", post(ticket))
        .route_layer(from_fn(csrf))
        .route_layer(from_fn_with_state(state.clone(), super::api_limit))
        .route_layer(from_fn_with_state(state.clone(), require_auth));
    let public = Router::new()
        .route("/open/{id}", get(open_with_ticket))
        .route("/file/{id}", get(serve_file).options(preflight))
        .route_layer(from_fn_with_state(state, super::api_limit))
        .route("/callback", post(callback).options(preflight).layer(DefaultBodyLimit::max(2 * 1024 * 1024)));
    authed.merge(public)
}

#[derive(Deserialize)]
pub struct ThemeQuery {
    theme: Option<String>,
}

fn theme(q: &ThemeQuery) -> Option<&str> {
    q.theme.as_deref().filter(|t| matches!(*t, "dark" | "light"))
}

fn origin(state: &AppState, ctx: &ReqCtx) -> String {
    let proto = ctx.forwarded_proto.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| "http".into());
    match ctx.host.as_deref().filter(|h| !h.is_empty()) {
        Some(host) => format!("{proto}://{host}"),
        None => state.config.backend_url.clone().unwrap_or_else(|| "http://localhost".into()),
    }
}

/// Who opens the document: the caller, acting on the owner's file.
struct Opener {
    user_id: String,
    owner_id: String,
    can_write: bool,
}

/// Look up and check the file, build the signed session and register force-save.
async fn open(
    state: &AppState,
    ctx: &ReqCtx,
    opener: &Opener,
    id: &str,
    theme: Option<&str>,
) -> Result<(StoredFile, oo::EditorSession), (StatusCode, String, Option<String>)> {
    let fail = |status, msg: &str| (status, msg.to_string(), None);
    let settings = state.settings.get().await;
    let (url, secret) = settings.onlyoffice().ok_or_else(|| fail(StatusCode::FAILED_DEPENDENCY, NOT_CONFIGURED))?;
    if !is_valid_id(id) {
        return Err(fail(StatusCode::BAD_REQUEST, "Invalid file ID"));
    }
    let internal = |err: anyhow::Error| {
        tracing::error!(error = %format!("{err:#}"), "[ONLYOFFICE] Config error");
        fail(StatusCode::INTERNAL_SERVER_ERROR, "Server error")
    };
    let file = crud::get(&state.pool, id, &opener.owner_id)
        .await
        .map_err(internal)?
        .ok_or_else(|| fail(StatusCode::NOT_FOUND, "File not found"))?;
    if let Err(reason) = oo::check_file(&file) {
        tracing::warn!(file_id = %file.id, error = %reason, "[ONLYOFFICE] Validation failed");
        return Err((StatusCode::BAD_REQUEST, reason, Some(file.name)));
    }
    let actor_name = users::by_id(state, &opener.user_id)
        .await
        .ok()
        .flatten()
        .map(|u| u.name.filter(|n| !n.is_empty()).unwrap_or(u.email))
        .unwrap_or_else(|| "User".into());
    let request_origin = origin(state, ctx);
    let session = oo::build_session(
        state,
        &url,
        &secret,
        &SessionRequest {
            file: &file,
            owner_id: &opener.owner_id,
            actor_id: &opener.user_id,
            actor_name: &actor_name,
            can_write: opener.can_write,
            mobile: oo::is_mobile(ctx.user_agent.as_deref()),
            theme,
            request_origin: &request_origin,
        },
    )
    .map_err(internal)?;
    let key = session.config["document"]["key"].as_str().unwrap_or_default().to_string();
    oo::register_open_document(state, &key, &file.id, &opener.owner_id).await;
    // Opening is the read; the document server's own fetches are not counted again.
    state.access.record_one(&file.id, &opener.owner_id);
    Ok((file, session))
}

fn opener(auth: &AuthUser) -> Opener {
    Opener { user_id: auth.user_id.clone(), owner_id: auth.owner_id.clone(), can_write: auth.can(Permission::Edit) }
}

pub async fn config(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<ThemeQuery>,
) -> ApiResult<Json<Value>> {
    auth::require(&state, &auth, &ctx, Permission::Download).await?;
    let (_, session) = open(&state, &ctx, &opener(&auth), &id, theme(&q))
        .await
        .map_err(|(status, message, _)| ApiError::new(status, message))?;
    Ok(Json(json!({ "config": session.config, "token": session.token, "onlyofficeJsUrl": session.js_url })))
}

/// The full-page editor, with the config token folded in.
async fn render_viewer(
    state: &AppState,
    ctx: &ReqCtx,
    who: &Opener,
    id: &str,
    theme: Option<&str>,
    nonce: &str,
    wants_json: bool,
) -> Response {
    match open(state, ctx, who, id, theme).await {
        Ok((file, mut session)) => {
            session.config["token"] = json!(session.token);
            let mode = session.config["editorConfig"]["mode"].clone();
            let file_type = session.config["document"]["fileType"].clone();
            state.audit.log(
                ctx,
                Event::new("document.open")
                    .resource("file", Some(&file.id))
                    .meta(json!({ "fileName": file.name, "fileType": file_type, "mode": mode })),
            );
            tracing::info!(file_id = %file.id, "Document opened in ONLYOFFICE");
            Html(viewer::editor_page(&file.name, &session.js_url, &session.config, theme, nonce)).into_response()
        }
        Err((status, message, Some(name))) if status == StatusCode::BAD_REQUEST => {
            if wants_json {
                return (status, Json(json!({ "message": message, "error": "MIME_TYPE_MISMATCH" }))).into_response();
            }
            (status, Html(viewer::cannot_open_page(&name, &message))).into_response()
        }
        Err((status, message, _)) => (status, message).into_response(),
    }
}

fn wants_json(headers: &HeaderMap) -> bool {
    headers.get(header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("application/json"))
        || headers.get("x-requested-with").is_some_and(|v| v == "XMLHttpRequest")
}

pub async fn viewer_page(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Extension(nonce): Extension<CspNonce>,
    Path(id): Path<String>,
    Query(q): Query<ThemeQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(err) = auth::require(&state, &auth, &ctx, Permission::Download).await {
        return err.into_response();
    }
    render_viewer(&state, &ctx, &opener(&auth), &id, theme(&q), &nonce.0, wants_json(&headers)).await
}

/// A one-minute link the desktop app opens in the system browser, which has no session cookie.
pub async fn ticket(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<ThemeQuery>,
) -> ApiResult<Json<Value>> {
    auth::require(&state, &auth, &ctx, Permission::Download).await?;
    if state.settings.get().await.onlyoffice().is_none() {
        return Err(ApiError::new(StatusCode::FAILED_DEPENDENCY, NOT_CONFIGURED));
    }
    if !is_valid_id(&id) {
        return Err(ApiError::bad_request("Invalid file ID"));
    }
    crud::get(&state.pool, &id, &auth.owner_id).await?.ok_or_else(|| ApiError::not_found("File not found"))?;
    let exp = chrono::Utc::now().timestamp() + TICKET_SECONDS;
    let claims = json!({
        "purpose": TICKET_PURPOSE, "fileId": id, "userId": auth.user_id, "ownerId": auth.owner_id,
        "canWrite": auth.can(Permission::Edit), "exp": exp,
    });
    let token = jwt::sign_value(&state.config.jwt_secret, &claims)?;
    let theme = theme(&q).map(|t| format!("&theme={t}")).unwrap_or_default();
    let url = format!(
        "{}/api/onlyoffice/open/{id}?ticket={}{theme}",
        origin(&state, &ctx),
        crate::util::encode_component(&token)
    );
    Ok(Json(json!({ "url": url, "expiresIn": TICKET_SECONDS })))
}

#[derive(Deserialize)]
pub struct OpenQuery {
    ticket: Option<String>,
    theme: Option<String>,
}

pub async fn open_with_ticket(
    State(state): State<AppState>,
    ctx: ReqCtx,
    Extension(nonce): Extension<CspNonce>,
    Path(id): Path<String>,
    Query(q): Query<OpenQuery>,
) -> Response {
    let claims = q.ticket.as_deref().and_then(|t| jwt::verify_value(&state.config.jwt_secret, t, true));
    let Some(claims) = claims.filter(|c| c["purpose"] == TICKET_PURPOSE && c["fileId"] == id.as_str()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Html(viewer::cannot_open_page(
                "Document link",
                "This link has expired. Open the document again from the app.",
            )),
        )
            .into_response();
    };
    let who = Opener {
        user_id: claims["userId"].as_str().unwrap_or_default().to_string(),
        owner_id: claims["ownerId"].as_str().unwrap_or_default().to_string(),
        can_write: claims["canWrite"].as_bool().unwrap_or(false),
    };
    let ctx = ReqCtx { user_id: Some(who.user_id.clone()), owner_id: Some(who.owner_id.clone()), ..ctx };
    let theme = q.theme.as_deref().filter(|t| matches!(*t, "dark" | "light"));
    render_viewer(&state, &ctx, &who, &id, theme, &nonce.0, false).await
}

fn cors(mut response: Response, methods: &'static str) -> Response {
    let h = response.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static(methods));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
    response
}

pub async fn preflight() -> Response {
    cors(StatusCode::OK.into_response(), "GET, POST, OPTIONS")
}

#[derive(Deserialize)]
pub struct FileQuery {
    t: Option<String>,
}

/// The document server fetches the file with the signed token from the config.
pub async fn serve_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Response {
    let reply = |status: StatusCode, error: &str| {
        cors((status, Json(json!({ "error": error }))).into_response(), "GET, OPTIONS")
    };
    if !is_valid_id(&id) {
        return reply(StatusCode::BAD_REQUEST, "Invalid file ID");
    }
    let Some((_, secret)) = state.settings.get().await.onlyoffice() else {
        return reply(StatusCode::FAILED_DEPENDENCY, "OnlyOffice integration not configured securely");
    };
    let Some(token) = q.t else { return reply(StatusCode::UNAUTHORIZED, "Missing token") };
    let claims = jwt::verify_value(&secret, &token, true);
    let Some(owner) = claims
        .as_ref()
        .filter(|c| c["fileId"] == id.as_str())
        .and_then(|c| c["userId"].as_str())
        .filter(|u| !u.is_empty())
    else {
        tracing::error!(file_id = %id, "[ONLYOFFICE] Token verification failed");
        return reply(StatusCode::UNAUTHORIZED, "Invalid token");
    };
    let file = match crud::get(&state.pool, &id, owner).await {
        Ok(Some(f)) if !f.is_folder() => f,
        Ok(_) => return reply(StatusCode::NOT_FOUND, "File not found"),
        Err(err) => {
            tracing::error!(error = %err, "[ONLYOFFICE] Error serving file");
            return reply(StatusCode::INTERNAL_SERVER_ERROR, "Server error");
        }
    };
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match download::serve(&state, &file, range, true).await {
        Ok(response) => cors(response, "GET, OPTIONS"),
        Err(err) => cors(err.into_response(), "GET, OPTIONS"),
    }
}

/// The callback's verified payload: the JWT in the body or the Authorization header.
fn verified_payload(body: &Value, headers: &HeaderMap, secret: &str) -> Option<Value> {
    let token =
        body.get("token").and_then(Value::as_str).filter(|t| !t.is_empty()).map(String::from).or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
        })?;
    let claims = jwt::verify_value(secret, &token, false)?;
    match claims.get("payload") {
        Some(inner @ Value::Object(_)) => Some(inner.clone()),
        _ => Some(claims),
    }
}

/// Status 2 (closed with changes) and 6 (force-save) carry a URL to the new
/// version. OnlyOffice retries anything but `{"error":0}`, so failures that a
/// retry cannot fix still answer 0.
pub async fn callback(
    State(state): State<AppState>,
    ctx: ReqCtx,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let reply = |status: StatusCode, error: i32| {
        cors((status, Json(json!({ "error": error }))).into_response(), "POST, OPTIONS")
    };
    let Some((oo_url, secret)) = state.settings.get().await.onlyoffice() else {
        tracing::error!("[ONLYOFFICE] Callback rejected - OnlyOffice JWT secret not configured");
        return reply(StatusCode::UNAUTHORIZED, 1);
    };
    let raw: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let Some(payload) = verified_payload(&raw, &headers, &secret) else {
        tracing::warn!("[ONLYOFFICE] Callback rejected - missing or invalid JWT signature");
        return reply(StatusCode::UNAUTHORIZED, 1);
    };
    let status = payload.get("status").and_then(Value::as_i64).unwrap_or(-1);
    let key = payload.get("key").and_then(Value::as_str).unwrap_or_default().to_string();
    if matches!(status, 2 | 4) {
        oo::unregister_open_document(&state, &key).await;
    }
    if status == 3 {
        tracing::error!(key, "[ONLYOFFICE] Document saving error");
    }
    let url = payload.get("url").and_then(Value::as_str);
    let (true, Some(url)) = (matches!(status, 2 | 6), url) else { return reply(StatusCode::OK, 0) };
    let Some((owner, file_id)) = oo::parse_document_key(&key).filter(|(o, f)| is_valid_id(o) && is_valid_id(f)) else {
        tracing::error!(key, "[ONLYOFFICE] Could not parse document key");
        return reply(StatusCode::OK, 0);
    };
    if !oo::is_allowed_download_url(url, &oo_url) {
        tracing::error!(url, "[ONLYOFFICE] Blocked save URL outside the document server");
        return reply(StatusCode::OK, 0);
    }
    match oo::save_document(&state, &owner, &file_id, url, &oo_url).await {
        Ok(SaveOutcome::Saved { name, new_size, old_size }) => {
            let ctx =
                ReqCtx { user_id: Some(owner.clone()), owner_id: Some(owner.clone()), role: Some("owner"), ..ctx };
            state.audit.log(
                &ctx,
                Event::new("document.save").resource("file", Some(&file_id)).meta(
                    json!({ "fileName": name, "fileSize": new_size, "oldSize": old_size, "savedVia": "onlyoffice" }),
                ),
            );
            tracing::info!(file_id, new_size, old_size, "Document saved via ONLYOFFICE");
            reply(StatusCode::OK, 0)
        }
        Ok(SaveOutcome::NotFound) => {
            tracing::error!(file_id, "[ONLYOFFICE] File not found or key account does not own it");
            reply(StatusCode::OK, 0)
        }
        Ok(SaveOutcome::QuotaExceeded) => {
            tracing::warn!(file_id, "[ONLYOFFICE] Save rejected because storage quota would be exceeded");
            reply(StatusCode::OK, 1)
        }
        Err(err) => {
            tracing::error!(error = %format!("{err:#}"), "[ONLYOFFICE] Callback error");
            reply(StatusCode::OK, 0)
        }
    }
}
