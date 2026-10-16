//! ONLYOFFICE Document Server integration: the signed editor config, the token
//! the document server presents to fetch a file, MIME checks, and force-save.

mod save;

pub use save::{SaveOutcome, is_allowed_download_url, save_document};

use serde_json::{Value, json};

use crate::auth::jwt;
use crate::jobs::queues;
use crate::models::files::crud::StoredFile;
use crate::state::AppState;

pub const EXTENSIONS: &[&str] = &[
    "docx", "doc", "docm", "dotx", "dotm", "dot", "xlsx", "xls", "xlsm", "xlsb", "xltx", "xltm", "csv", "pptx", "ppt",
    "pptm", "ppsx", "ppsm", "pps", "potx", "potm", "odt", "ods", "odp", "pdf",
];

pub fn is_supported(name: &str) -> bool {
    EXTENSIONS.contains(&tma_core::names::extension_of(name).as_str())
}

/// MIME types detection or clients report for an extension that the MIME
/// database does not list for it (OLE containers, CSV as text, SVG as XML).
fn aliases(ext: &str) -> &'static [&'static str] {
    match ext {
        "doc" | "dot" | "xls" | "ppt" | "pps" | "pot" | "msi" => {
            &["application/x-cfb", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint"]
        }
        "docx" => &[
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
            "application/zip",
        ],
        "xlsx" => &[
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "application/zip",
        ],
        "pptx" => &[
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.ms-powerpoint",
            "application/zip",
        ],
        "docm" | "dotx" | "dotm" | "xlsm" | "xlsb" | "xltx" | "xltm" | "pptm" | "ppsx" | "ppsm" | "potx" | "potm" => {
            &["application/zip"]
        }
        "odt" | "ods" | "odp" => &["application/zip"],
        "csv" => &["text/plain", "application/csv", "application/x-csv", "text/csv"],
        "rtf" => &["application/rtf", "text/rtf"],
        "pdf" => &["application/x-pdf", "application/acrobat", "application/vnd.pdf", "text/pdf", "text/x-pdf"],
        _ => &[],
    }
}

/// Whether the stored type fits what the document server expects for the extension.
pub fn mime_matches(name: &str, stored: Option<&str>) -> Result<(), String> {
    let ext = tma_core::names::extension_of(name);
    let Some(stored) =
        stored.map(|m| m.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).filter(|m| !m.is_empty())
    else {
        return Err("File MIME type not available. Cannot verify file type for encrypted file.".into());
    };
    let mut expected: Vec<String> = mime_guess::from_ext(&ext).iter_raw().map(|m| m.to_ascii_lowercase()).collect();
    expected.extend(aliases(&ext).iter().map(|m| m.to_string()));
    if expected.is_empty() {
        return Err(format!("File extension .{ext} is not recognized or not supported by ONLYOFFICE"));
    }
    if expected.contains(&stored) || stored == "application/octet-stream" {
        Ok(())
    } else {
        tracing::warn!(name, stored, "[ONLYOFFICE] Stored MIME type does not match expected type for extension");
        Err(format!("Cannot open file: type mismatch (expected .{ext} format)"))
    }
}

pub fn check_file(file: &StoredFile) -> Result<(), String> {
    if !is_supported(&file.name) {
        return Err("File type is not supported by ONLYOFFICE".into());
    }
    if file.path.as_deref().is_none_or(|p| !crate::transfer::download::is_valid_key(p)) {
        return Err("File not found".into());
    }
    mime_matches(&file.name, file.mime_type.as_deref())
}

/// What the browser needs to open a document.
pub struct EditorSession {
    pub config: Value,
    pub token: String,
    pub js_url: String,
}

/// Who opens which document, and how.
pub struct SessionRequest<'a> {
    pub file: &'a StoredFile,
    pub owner_id: &'a str,
    pub actor_id: &'a str,
    pub actor_name: &'a str,
    pub can_write: bool,
    pub mobile: bool,
    pub theme: Option<&'a str>,
    /// Where the document server reaches this API when `BACKEND_URL` is unset.
    pub request_origin: &'a str,
}

/// Build and sign the editor config. The document key carries the owning
/// account; the save callback parses it back out to find the file.
pub fn build_session(
    state: &AppState,
    server_url: &str,
    secret: &str,
    req: &SessionRequest<'_>,
) -> anyhow::Result<EditorSession> {
    let file = req.file;
    let now = chrono::Utc::now().timestamp();
    let file_token =
        jwt::sign_value(secret, &json!({ "fileId": file.id, "userId": req.owner_id, "iat": now, "exp": now + 600 }))?;
    let base = state.config.backend_url.clone().unwrap_or_else(|| req.request_origin.to_string());
    let download_url =
        format!("{base}/api/onlyoffice/file/{}?t={}", file.id, crate::util::encode_component(&file_token));
    let file_type = {
        let ext = tma_core::names::extension_of(&file.name);
        if ext.is_empty() { "docx".to_string() } else { ext }
    };
    let view_only = file_type == "pdf" || !req.can_write;
    let mut customization = json!({ "autosave": !view_only, "forcesave": !view_only });
    match req.theme {
        Some("dark") => customization["uiTheme"] = json!("theme-dark"),
        Some("light") => customization["uiTheme"] = json!("theme-light"),
        _ => {}
    }
    let key = format!("{}-{}-{}", req.owner_id, file.id, chrono::Utc::now().timestamp_millis());
    let config = json!({
        "document": { "fileType": file_type, "key": key, "title": file.name, "url": download_url },
        "editorConfig": {
            "callbackUrl": format!("{base}/api/onlyoffice/callback"),
            "mode": if view_only { "view" } else { "edit" },
            "lang": "en",
            "customization": customization,
            "user": { "id": req.actor_id, "name": req.actor_name },
        },
        "type": if req.mobile { "mobile" } else { "desktop" },
    });
    let token = jwt::sign_value(secret, &config)?;
    Ok(EditorSession { config, token, js_url: format!("{server_url}/web-apps/apps/api/documents/api.js") })
}

pub fn is_mobile(user_agent: Option<&str>) -> bool {
    let ua = user_agent.unwrap_or("").to_ascii_lowercase();
    ["android", "webos", "iphone", "ipad", "ipod", "blackberry", "iemobile", "opera mini"]
        .iter()
        .any(|m| ua.contains(m))
}

/// `(owner_id, file_id)` from a document key `owner-file-timestamp`.
pub fn parse_document_key(key: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() < 3 {
        return None;
    }
    let owner = parts[0];
    let file = parts[1..parts.len() - 1].join("-");
    (!owner.is_empty() && !file.is_empty()).then(|| (owner.to_string(), file))
}

/// Force-save an open document every five minutes so an editor crash loses little.
pub async fn register_open_document(state: &AppState, key: &str, file_id: &str, owner: &str) {
    let data = json!({ "documentKey": key, "fileId": file_id, "userId": owner });
    if let Err(err) =
        state.jobs.schedule(&format!("onlyoffice:{key}"), queues::ONLYOFFICE_FORCESAVE, "*/5 * * * *", data).await
    {
        tracing::warn!(error = %err, key, "[ONLYOFFICE-AUTOSAVE] Failed to schedule document");
    }
}

pub async fn unregister_open_document(state: &AppState, key: &str) {
    if let Err(err) = state.jobs.unschedule(&format!("onlyoffice:{key}")).await {
        tracing::warn!(error = %err, key, "[ONLYOFFICE-AUTOSAVE] Failed to remove document schedule");
    }
}

/// The outcome of one force-save command.
pub enum ForceSave {
    Saved,
    NoChanges,
    Closed,
}

/// Ask the document server to save now; `/command` first, the pre-8.2 path on 404.
pub async fn force_save(state: &AppState, key: &str) -> anyhow::Result<ForceSave> {
    let settings = state.settings.get().await;
    let (url, secret) = settings.onlyoffice().ok_or_else(|| anyhow::anyhow!("ONLYOFFICE URL is not configured"))?;
    let payload = json!({ "c": "forcesave", "key": key });
    let body = json!({ "token": jwt::sign_value(&secret, &payload)? });
    let mut response = None;
    for path in ["/command", "/coauthoring/CommandService.ashx"] {
        let res = state
            .http
            .post(format!("{url}{path}?shardkey={}", crate::util::encode_component(key)))
            .json(&body)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;
        if res.status().as_u16() == 404 && path == "/command" {
            continue;
        }
        response = Some(res);
        break;
    }
    let res = response.ok_or_else(|| anyhow::anyhow!("ONLYOFFICE command service not found"))?;
    if !res.status().is_success() {
        anyhow::bail!("ONLYOFFICE command returned HTTP {}", res.status().as_u16());
    }
    let reply: Value =
        res.json().await.map_err(|e| anyhow::anyhow!("ONLYOFFICE command returned invalid JSON: {e}"))?;
    match reply.get("error").and_then(Value::as_i64).unwrap_or(0) {
        0 => Ok(ForceSave::Saved),
        1 => Ok(ForceSave::Closed),
        4 => Ok(ForceSave::NoChanges),
        code => anyhow::bail!("ONLYOFFICE force-save error {code}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_mime() {
        assert_eq!(parse_document_key("owner123-file456-1700000000000"), Some(("owner123".into(), "file456".into())));
        assert!(parse_document_key("bad").is_none());
        assert!(
            mime_matches("a.docx", Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
                .is_ok()
        );
        assert!(mime_matches("a.csv", Some("text/plain")).is_ok());
        assert!(mime_matches("a.docx", Some("image/png")).is_err());
    }
}
