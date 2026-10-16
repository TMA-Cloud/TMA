//! What differs between the browser and the desktop: picking files, saving
//! downloads, dropped files and opening links.

use tma_client::{Source, UploadFile};

/// Files chosen in the system picker.
pub async fn pick_files() -> Vec<UploadFile> {
    let Some(handles) = rfd::AsyncFileDialog::new().set_title("Upload files").pick_files().await else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let path = handle.path().to_path_buf();
            if let Some(file) = from_path(&path, None) {
                out.push(file);
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            let name = handle.file_name();
            let bytes = handle.read().await;
            out.push(UploadFile {
                name,
                size: bytes.len() as u64,
                source: Source::Bytes(bytes.into()),
                modified_ms: None,
                relative_dir: None,
            });
        }
    }
    out
}

/// A whole folder, keeping its structure (desktop only; browsers cannot pick folders here).
pub async fn pick_folder() -> Vec<UploadFile> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let Some(handle) = rfd::AsyncFileDialog::new().set_title("Upload a folder").pick_folder().await else {
            return Vec::new();
        };
        let root = handle.path().to_path_buf();
        let top = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut out = Vec::new();
        walk(&root, &top, &mut out);
        out
    }
    #[cfg(target_arch = "wasm32")]
    Vec::new()
}

#[cfg(not(target_arch = "wasm32"))]
fn walk(dir: &std::path::Path, relative: &str, out: &mut Vec<UploadFile>) {
    // Very deep or huge trees are capped so a stray pick cannot exhaust memory.
    if out.len() > 50_000 || relative.matches('/').count() > 64 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk(&path, &format!("{relative}/{name}"), out),
            Ok(kind) if kind.is_file() => {
                if let Some(file) = from_path(&path, Some(relative.to_string())) {
                    out.push(file);
                }
            }
            _ => {}
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn from_path(path: &std::path::Path, relative_dir: Option<String>) -> Option<UploadFile> {
    let meta = std::fs::metadata(path).ok()?;
    let name = path.file_name()?.to_string_lossy().to_string();
    let modified_ms =
        meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    Some(UploadFile { name, size: meta.len(), source: Source::Path(path.to_path_buf()), modified_ms, relative_dir })
}

/// Local files and folders to upload; folders keep their structure (desktop only).
#[cfg(not(target_arch = "wasm32"))]
pub fn uploads_from_paths(paths: &[std::path::PathBuf]) -> Vec<UploadFile> {
    let mut out = Vec::new();
    for path in paths {
        if path.is_dir() {
            let top = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            walk(path, &top, &mut out);
        } else if let Some(upload) = from_path(path, None) {
            out.push(upload);
        }
    }
    out
}

/// Files dropped on the window: paths on desktop (folders keep their structure), read bytes on the web.
pub async fn dropped(files: Vec<egui::DroppedFileHandle>) -> Vec<UploadFile> {
    let mut out = Vec::new();
    for file in files {
        #[cfg(not(target_arch = "wasm32"))]
        out.extend(uploads_from_paths(&[file.path().to_path_buf()]));
        #[cfg(target_arch = "wasm32")]
        {
            let name = file
                .path()
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "Untitled".into());
            match file.bytes_async().await {
                Ok(bytes) => out.push(UploadFile {
                    name,
                    size: bytes.len() as u64,
                    source: Source::Bytes(bytes.into()),
                    modified_ms: None,
                    relative_dir: None,
                }),
                Err(err) => log::warn!("Cannot read dropped file {name}: {err}"),
            }
        }
    }
    out
}

/// Where to save a download (desktop).
#[cfg(not(target_arch = "wasm32"))]
pub async fn save_path(suggested: String) -> Option<std::path::PathBuf> {
    rfd::AsyncFileDialog::new()
        .set_title("Save")
        .set_file_name(&suggested)
        .save_file()
        .await
        .map(|h| h.path().to_path_buf())
}

/// Let the browser download a URL (the session cookie authorizes it).
#[cfg(target_arch = "wasm32")]
pub fn browser_download(url: &str, name: &str) {
    use wasm_bindgen::JsCast;
    let Some(document) = web_sys::window().and_then(|w| w.document()) else { return };
    let Ok(element) = document.create_element("a") else { return };
    let Ok(anchor) = element.dyn_into::<web_sys::HtmlAnchorElement>() else { return };
    anchor.set_href(url);
    anchor.set_download(name);
    anchor.click();
}

/// Post a download ticket from a hidden form, so the browser streams the response to disk.
/// The form targets a hidden frame: an error page lands there instead of replacing the app.
#[cfg(target_arch = "wasm32")]
pub fn browser_post_download(url: &str, ticket: &str) {
    use wasm_bindgen::JsCast;
    const FRAME: &str = "tma-download-frame";
    let Some(document) = web_sys::window().and_then(|w| w.document()) else { return };
    let Some(body) = document.body() else { return };
    if document.get_element_by_id(FRAME).is_none() {
        let Ok(frame) = document.create_element("iframe") else { return };
        let _ = frame.set_attribute("id", FRAME);
        let _ = frame.set_attribute("name", FRAME);
        let _ = frame.set_attribute("hidden", "");
        let _ = body.append_child(&frame);
    }
    let (Ok(form), Ok(input)) = (document.create_element("form"), document.create_element("input")) else { return };
    let _ = form.set_attribute("method", "post");
    let _ = form.set_attribute("action", url);
    let _ = form.set_attribute("target", FRAME);
    let _ = input.set_attribute("type", "hidden");
    let _ = input.set_attribute("name", "ticket");
    let _ = input.set_attribute("value", ticket);
    let _ = form.append_child(&input);
    let _ = body.append_child(&form);
    if let Ok(form) = form.dyn_into::<web_sys::HtmlFormElement>() {
        let _ = form.submit();
        form.remove();
    }
}

/// Open a link in a new browser tab (web) or the default browser (desktop host).
pub fn open_url(url: &str) {
    #[cfg(target_arch = "wasm32")]
    if let Some(window) = web_sys::window() {
        let _ = window.open_with_url_and_target(url, "_blank");
    }
    #[cfg(not(target_arch = "wasm32"))]
    log::info!("open {url}");
}

/// Replace the page (web sign-in redirects).
pub fn navigate(url: &str) {
    #[cfg(target_arch = "wasm32")]
    if let Some(window) = web_sys::window() {
        let _ = window.location().assign(url);
    }
    #[cfg(not(target_arch = "wasm32"))]
    log::info!("navigate {url}");
}
