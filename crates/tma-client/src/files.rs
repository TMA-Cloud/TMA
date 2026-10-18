//! Listings, search, folder operations, trash and sharing.

use serde_json::{Value, json};
use tma_core::api::{
    FileInfo, FileItem, FileStats, JobStatus, LockResponse, QueuedResponse, ShareLinks, ShareRequest, SortBy, SortOrder,
};

use crate::error::ApiResult;
use crate::http::{Client, enc};

/// Which listing to fetch.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum View {
    /// A folder, or the root with `None`.
    Folder(Option<String>),
    Starred,
    Shared,
    Trash,
}

/// Sort and paging for a listing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListQuery {
    pub sort: Option<SortBy>,
    pub order: Option<SortOrder>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// One page of a listing; `next_cursor` fetches the rest.
#[derive(Debug, Clone, Default)]
pub struct Listing {
    pub files: Vec<FileItem>,
    pub next_cursor: Option<String>,
}

/// A trash or restore answer: done now, or handed to the worker.
fn queued_or_done(value: Value) -> QueuedResponse {
    serde_json::from_value(value).unwrap_or_default()
}

impl Client {
    pub async fn list(&self, view: &View, query: &ListQuery) -> ApiResult<Listing> {
        let (path, mut params) = match view {
            View::Folder(parent) => {
                ("/api/files", parent.iter().map(|p| format!("parentId={}", enc(p))).collect::<Vec<_>>())
            }
            View::Starred => ("/api/files/starred", Vec::new()),
            View::Shared => ("/api/files/shared", Vec::new()),
            View::Trash => ("/api/files/trash", Vec::new()),
        };
        if let Some(sort) = query.sort {
            params.push(format!("sortBy={}", sort.as_str()));
        }
        if let Some(order) = query.order {
            params.push(format!("order={}", order.as_str()));
        }
        if let Some(cursor) = &query.cursor {
            params.push(format!("cursor={}", enc(cursor)));
        }
        if let Some(limit) = query.limit {
            params.push(format!("limit={limit}"));
        }
        let url = if params.is_empty() { path.to_string() } else { format!("{path}?{}", params.join("&")) };
        let response = self.send(self.request(reqwest::Method::GET, &url)).await?;
        let next_cursor = response.headers().get("x-next-cursor").and_then(|v| v.to_str().ok()).map(String::from);
        let files =
            response.json().await.map_err(|e| crate::ApiError::local(format!("Unexpected server response: {e}")))?;
        Ok(Listing { files, next_cursor })
    }

    pub async fn search(&self, query: &str, limit: u32) -> ApiResult<Vec<FileItem>> {
        self.get(&format!("/api/files/search?q={}&limit={limit}", enc(query))).await
    }

    pub async fn recent(&self, limit: u32) -> ApiResult<Vec<FileItem>> {
        self.get(&format!("/api/files/recent?limit={limit}")).await
    }

    pub async fn stats(&self) -> ApiResult<FileStats> {
        self.get("/api/files/stats").await
    }

    pub async fn info(&self, id: &str) -> ApiResult<FileInfo> {
        self.get(&format!("/api/files/{}/info", enc(id))).await
    }

    /// Take or renew the edit lock on a file; `acquired` is false while someone else holds it.
    pub async fn lock(&self, id: &str) -> ApiResult<LockResponse> {
        self.post(&format!("/api/files/{}/lock", enc(id)), &json!({})).await
    }

    pub async fn unlock(&self, id: &str) -> ApiResult<Value> {
        self.delete(&format!("/api/files/{}/lock", enc(id))).await
    }

    pub async fn create_folder(&self, name: &str, parent: Option<&str>) -> ApiResult<FileItem> {
        self.post("/api/files/folder", &json!({ "name": name, "parentId": parent })).await
    }

    pub async fn rename(&self, id: &str, name: &str) -> ApiResult<FileItem> {
        self.post("/api/files/rename", &json!({ "id": id, "name": name })).await
    }

    pub async fn move_items(&self, ids: &[String], parent: Option<&str>) -> ApiResult<Value> {
        self.post("/api/files/move", &json!({ "ids": ids, "parentId": parent })).await
    }

    pub async fn copy_items(&self, ids: &[String], parent: Option<&str>) -> ApiResult<QueuedResponse> {
        self.post("/api/files/copy", &json!({ "ids": ids, "parentId": parent })).await
    }

    pub async fn star(&self, ids: &[String], starred: bool) -> ApiResult<Value> {
        self.post("/api/files/star", &json!({ "ids": ids, "starred": starred })).await
    }

    /// Share (`expiry` "7d", "30d" or "never") or unshare; returns the links.
    pub async fn share(&self, ids: &[String], shared: bool, expiry: Option<&str>) -> ApiResult<ShareLinks> {
        let body = ShareRequest { ids: ids.to_vec(), shared: Some(shared), expiry: expiry.map(String::from) };
        let value: Value = self.post("/api/files/share", &body).await?;
        Ok(serde_json::from_value(value).unwrap_or_default())
    }

    pub async fn share_links(&self, ids: &[String]) -> ApiResult<ShareLinks> {
        self.post("/api/files/share/links", &json!({ "ids": ids })).await
    }

    pub async fn link_parent_share(&self, ids: &[String]) -> ApiResult<ShareLinks> {
        self.post("/api/files/link-parent-share", &json!({ "ids": ids })).await
    }

    pub async fn trash(&self, ids: &[String]) -> ApiResult<QueuedResponse> {
        self.post("/api/files/delete", &json!({ "ids": ids })).await.map(queued_or_done)
    }

    pub async fn restore(&self, ids: &[String]) -> ApiResult<QueuedResponse> {
        self.post("/api/files/trash/restore", &json!({ "ids": ids })).await.map(queued_or_done)
    }

    pub async fn delete_forever(&self, ids: &[String]) -> ApiResult<QueuedResponse> {
        self.post("/api/files/trash/delete", &json!({ "ids": ids })).await.map(queued_or_done)
    }

    pub async fn empty_trash(&self) -> ApiResult<QueuedResponse> {
        self.post("/api/files/trash/empty", &json!({})).await.map(queued_or_done)
    }

    /// A queued file operation; `status` is "completed" once it is done.
    pub async fn file_job(&self, job_id: &str) -> ApiResult<JobStatus> {
        self.get(&format!("/api/files/jobs/{}", enc(job_id))).await
    }

    /// Poll a queued file job until it finishes (or fails).
    /// Wait for the job a request queued, if it queued one.
    pub async fn settle(&self, queued: &QueuedResponse) -> ApiResult<()> {
        if let Some(job) = &queued.job_id {
            self.wait_for_job(job).await?;
        }
        Ok(())
    }

    pub async fn wait_for_job(&self, job_id: &str) -> ApiResult<JobStatus> {
        let mut delay = 300u64;
        loop {
            let status = self.file_job(job_id).await?;
            if status.status == "completed" {
                return Ok(status);
            }
            crate::rt::sleep(std::time::Duration::from_millis(delay)).await;
            delay = (delay * 3 / 2).min(3000);
        }
    }

    /// A one-minute link that opens a document in the system browser (desktop app).
    pub async fn onlyoffice_ticket(&self, id: &str, theme: &str) -> ApiResult<String> {
        let value: Value =
            self.post(&format!("/api/onlyoffice/ticket/{}?theme={}", enc(id), enc(theme)), &json!({})).await?;
        value
            .get("url")
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| crate::ApiError::local("The server did not return a document link"))
    }

    /// The editor config for a document, to mount OnlyOffice inside the web app:
    /// `config`, `token` and `onlyofficeJsUrl` (the document server's API script).
    pub async fn document_editor(&self, id: &str, theme: &str) -> ApiResult<Value> {
        self.get(&format!("/api/onlyoffice/config/{}?theme={}", enc(id), enc(theme))).await
    }

    /// Where a file downloads from (the session cookie authorizes it).
    pub fn download_url(&self, id: &str) -> String {
        self.url(&format!("/api/files/{}/download", enc(id)))
    }

    /// An image's bytes for previews and the viewer.
    pub async fn file_bytes(&self, id: &str) -> ApiResult<bytes::Bytes> {
        let response =
            self.send(self.request(reqwest::Method::GET, &format!("/api/files/{}/download?inline=1", enc(id)))).await?;
        response.bytes().await.map_err(crate::ApiError::network)
    }
}
