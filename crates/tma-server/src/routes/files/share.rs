//! Creating and revoking public links, and reading them back.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};
use tma_core::Permission;
use tma_core::api::ShareLinks;

use crate::auth::{self, AuthUser};
use crate::error::{ApiError, ApiResult, message};
use crate::middleware::ReqCtx;
use crate::models::files::listing;
use crate::models::shares;
use crate::routes::{JsonBody, require_ids};
use crate::services::audit::Event;
use crate::services::events::types;
use crate::state::AppState;

/// The public origin links use: the configured share domain, else this request's origin.
pub async fn base_url(state: &AppState, ctx: &ReqCtx) -> String {
    if let Some(origin) = state.settings.get().await.share_base_origin() {
        return origin;
    }
    let proto = ctx.forwarded_proto.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| {
        let secure = state.config.backend_url.as_deref().is_some_and(|u| u.starts_with("https://"));
        if secure { "https".into() } else { "http".into() }
    });
    match ctx.host.as_deref().filter(|h| !h.is_empty()) {
        Some(host) => format!("{proto}://{host}"),
        None => state.config.backend_url.clone().unwrap_or_else(|| "http://localhost".into()),
    }
}

pub fn link(base: &str, token: &str) -> String {
    format!("{}/s/{}", base.trim_end_matches('/'), crate::util::encode_component(token))
}

fn expires_at(expiry: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    match expiry {
        Some("never") => None,
        Some("30d") => Some(chrono::Utc::now() + chrono::Duration::days(30)),
        _ => Some(chrono::Utc::now() + chrono::Duration::days(7)),
    }
}

/// `ids` may be one string or an array; `shared` may be a boolean or its string form.
fn parse_share_body(body: &Value) -> Result<(Vec<String>, bool, Option<String>), ApiError> {
    let ids: Vec<String> = match body.get("ids") {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= 500 => {
            items.iter().map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).collect()
        }
        _ => return Err(ApiError::validation("ids", "File IDs must contain between 1 and 500 entries")),
    };
    let shared = match body.get("shared") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" || s == "false" => s == "true",
        Some(_) => return Err(ApiError::validation("shared", "Shared must be a boolean")),
    };
    let expiry = match body.get("expiry").and_then(|v| v.as_str()) {
        None => None,
        Some(e @ ("7d" | "30d" | "never")) => Some(e.to_string()),
        Some(_) => return Err(ApiError::validation("expiry", "Expiry must be 7d, 30d, or never")),
    };
    Ok((ids, shared, expiry))
}

pub async fn share(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<Value>,
) -> ApiResult<Json<Value>> {
    auth::require(&state, &auth, &ctx, Permission::Share).await?;
    let (ids, shared, expiry) = parse_share_body(&body)?;
    let items = listing::briefs(&state.pool, &ids, &auth.owner_id, false).await?;
    if !shared {
        let affected = shares::unshare_roots(&state.pool, &ids, &auth.owner_id).await?;
        for token in &affected {
            shares::forget_token(&state.cache, token).await;
        }
        state.audit.log(
            &ctx,
            Event::new("share.delete")
                .resource("share", ids.first().map(String::as_str))
                .meta(json!({ "fileCount": ids.len(), "fileIds": ids })),
        );
        let events = items.iter().map(|i| (types::FILE_SHARED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": i.parent_id, "shared": false, "userId": auth.owner_id }))).collect();
        state.events.publish_batch(&auth.owner_id, events).await;
        return Ok(message("Files unshared successfully."));
    }
    // Only the caller's own items: another account's ID must never get a live link.
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    if items.len() != unique.len() {
        return Err(ApiError::not_found("File not found"));
    }
    let expiry_label = expiry.clone().unwrap_or_else(|| "7d".into());
    let (tokens, counts, created) =
        shares::upsert_roots(&state.pool, &ids, &auth.owner_id, expires_at(expiry.as_deref())).await?;
    for token in tokens.values() {
        shares::forget_token(&state.cache, token).await;
    }
    for root in &created {
        let token = tokens.get(root).cloned().unwrap_or_default();
        state.audit.log(
            &ctx,
            Event::new("share.create")
                .resource("share", Some(&token))
                .meta(json!({ "fileId": root, "fileCount": counts.get(root), "expiry": expiry_label })),
        );
    }
    let base = base_url(&state, &ctx).await;
    let links: BTreeMap<String, String> =
        ids.iter().filter_map(|id| tokens.get(id).map(|t| (id.clone(), link(&base, t)))).collect();
    let events = items.iter().map(|i| (types::FILE_SHARED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": i.parent_id, "shared": true, "userId": auth.owner_id }))).collect();
    state.events.publish_batch(&auth.owner_id, events).await;
    Ok(Json(json!({ "links": links })))
}

#[derive(serde::Deserialize)]
pub struct IdsOnly {
    ids: Option<Vec<String>>,
}

/// Reading a link hands account content to outsiders, so it needs the share grant.
pub async fn links(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsOnly>,
) -> ApiResult<Json<ShareLinks>> {
    auth::require(&state, &auth, &ctx, Permission::Share).await?;
    let ids = require_ids(&body.ids)?;
    let tokens = shares::links_for(&state.pool, &ids, &auth.owner_id).await?;
    let base = base_url(&state, &ctx).await;
    Ok(Json(ShareLinks { links: tokens.into_iter().map(|(id, t)| (id, link(&base, &t))).collect() }))
}

pub async fn link_parent(
    State(state): State<AppState>,
    ctx: ReqCtx,
    auth: AuthUser,
    JsonBody(body): JsonBody<IdsOnly>,
) -> ApiResult<Json<ShareLinks>> {
    auth::require(&state, &auth, &ctx, Permission::Share).await?;
    let ids = require_ids(&body.ids)?;
    let mappings = shares::link_to_parent_shares(&state.pool, &ids, &auth.owner_id).await?;
    let base = base_url(&state, &ctx).await;
    let mut links = BTreeMap::new();
    for (root, token) in &mappings {
        shares::forget_token(&state.cache, token).await;
        links.insert(root.clone(), link(&base, token));
    }
    let linked: Vec<String> = links.keys().cloned().collect();
    let items = listing::briefs(&state.pool, &linked, &auth.owner_id, false).await?;
    let events = items.iter().map(|i| (types::FILE_SHARED, json!({ "id": i.id, "name": i.name, "type": i.item_type, "parentId": i.parent_id, "shared": true, "userId": auth.owner_id }))).collect();
    state.events.publish_batch(&auth.owner_id, events).await;
    Ok(Json(ShareLinks { links }))
}
