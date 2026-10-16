//! The public share pages: one server response each, themed by CSS custom
//! properties so light and dark are one media query, with no script at all;
//! large folders page with a plain link.

use tma_core::api::{ItemType, SharedItem, SharedPage};
use tma_core::{FileKind, file_kind};

use crate::util::escape_html as esc;

const BASE_STYLE: &str = include_str!("share.css");

const ICON_SPRITE: &str = r#"<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-4 4 3 3-2 4 3"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/></symbol>
<symbol id="i-audio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></symbol>
<symbol id="i-pdf" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/><path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8Zm0 3v2m8-5v5m0-3h1.6M12 13v5"/></symbol>
<symbol id="i-sheet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/></symbol>
<symbol id="i-archive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v3m0 2v2m0 2v2"/><rect x="10" y="14" width="4" height="4" rx="1"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></symbol>
<symbol id="i-slides" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-4 0h8"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/><path d="M8 12h8M8 15h8M8 18h5"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"/></symbol>
<symbol id="i-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></symbol>
</svg>"#;

fn icon(id: &str, class: &str) -> String {
    format!(r##"<svg class="{class}" aria-hidden="true"><use href="#{id}"/></svg>"##)
}

fn icon_for(kind: FileKind) -> &'static str {
    match kind {
        FileKind::Document | FileKind::Text => "i-doc",
        FileKind::Pdf => "i-pdf",
        FileKind::Spreadsheet | FileKind::Database => "i-sheet",
        FileKind::Presentation => "i-slides",
        FileKind::Image | FileKind::Design => "i-image",
        FileKind::Video => "i-video",
        FileKind::Audio => "i-audio",
        FileKind::Archive => "i-archive",
        FileKind::Code => "i-code",
        _ => "i-file",
    }
}

fn kind_label(name: &str, mime: Option<&str>) -> String {
    let label = file_kind(name, mime).label();
    let ext = tma_core::names::extension_of(name).to_uppercase();
    if ext.is_empty() { label.to_string() } else { format!("{ext} · {label}") }
}

fn page(title: &str, extra_style: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{}</title><style>{BASE_STYLE}{extra_style}</style></head><body>{body}</body></html>",
        esc(title)
    )
}

pub fn error_page(title: &str, message: &str) -> String {
    page(
        title,
        "body{display:flex;align-items:center;justify-content:center;min-height:100vh}.card{text-align:center;max-width:420px}\
         .card h1{font-size:22px;margin:0 0 8px}.card p{color:var(--muted);margin:0}",
        &format!("<div class=\"card\"><h1>{}</h1><p>{}</p></div>", esc(title), esc(message)),
    )
}

fn row(item: &SharedItem, token: &str) -> String {
    let id = esc(&item.id);
    let is_folder = item.item_type == ItemType::Folder;
    let href = if is_folder { format!("/s/{token}/folder/{id}") } else { format!("/s/{token}/file/{id}") };
    let meta = if is_folder { "Folder".to_string() } else { tma_core::format::share_size(item.size.unwrap_or(0)) };
    let art = if is_folder { "i-folder" } else { icon_for(file_kind(&item.name, item.mime_type.as_deref())) };
    format!(
        "<a class=\"row\" href=\"{href}\"{dl}>{}<span class=\"meta\"><span class=\"name\">{}</span>{}</span>{}</a>",
        icon(art, if is_folder { "ic folder" } else { "ic" }),
        esc(&item.name),
        if meta.is_empty() { String::new() } else { format!("<span class=\"size\">{}</span>", esc(&meta)) },
        icon(if is_folder { "i-chevron" } else { "i-download" }, "go"),
        dl = if is_folder { "" } else { " download" },
    )
}

/// A shared folder (the root or a subfolder browsed into).
pub fn folder_page(
    listing: &SharedPage,
    token: &str,
    heading: &str,
    trail: &[(String, String)],
    zip_href: &str,
) -> String {
    let t = esc(token);
    let files = listing.items.iter().filter(|i| i.item_type != ItemType::Folder).count();
    let folders = listing.items.len() - files;
    let total: i64 = listing.items.iter().map(|i| i.size.unwrap_or(0)).sum();
    let mut parts = Vec::new();
    if folders > 0 {
        parts.push(tma_core::format::count(folders, "folder", "folders"));
    }
    if files > 0 {
        parts.push(tma_core::format::count(files, "file", "files"));
    }
    let size = tma_core::format::share_size(total);
    if !size.is_empty() {
        parts.push(size);
    }
    let mut subtitle = if parts.is_empty() { "Empty folder".to_string() } else { parts.join(" · ") };
    if listing.next_cursor.is_some() {
        subtitle.push_str(" · more below");
    }
    let crumbs = if trail.len() >= 2 {
        let items: Vec<String> = trail
            .iter()
            .enumerate()
            .map(|(i, (id, name))| {
                if i == trail.len() - 1 {
                    format!("<span aria-current=\"page\">{}</span>", esc(name))
                } else if i == 0 {
                    format!("<a href=\"/s/{t}\">{}</a>", esc(name))
                } else {
                    format!("<a href=\"/s/{t}/folder/{}\">{}</a>", esc(id), esc(name))
                }
            })
            .collect();
        format!("<nav class=\"crumbs\" aria-label=\"Breadcrumb\">{}</nav>", items.join(&icon("i-chevron", "crumb-sep")))
    } else {
        String::new()
    };
    let body = if listing.items.is_empty() {
        "<div class=\"list\"><div class=\"empty\">This shared folder is empty.</div></div>".to_string()
    } else {
        format!(
            "<div class=\"list\" id=\"share-list\">{}</div>",
            listing.items.iter().map(|i| row(i, token)).collect::<String>()
        )
    };
    let download_all = if listing.items.is_empty() {
        String::new()
    } else {
        format!(
            "<a class=\"dl-all\" href=\"{}\">{}<span>Download all</span></a>",
            esc(zip_href),
            icon("i-download", "")
        )
    };
    let pager = match &listing.next_cursor {
        Some(cursor) => format!(
            "<nav class=\"pager\"><a class=\"more\" href=\"?cursor={}\">Show more</a></nav>",
            crate::util::encode_component(cursor)
        ),
        None => String::new(),
    };
    page(
        heading,
        "",
        &format!(
            "{ICON_SPRITE}<div class=\"wrap\">{crumbs}<header class=\"head\"><div class=\"title\">{}<div><h1>{}</h1>\
             <div class=\"sub\">{}</div></div></div>{download_all}</header>{body}{pager}\
             <p class=\"foot\">Shared securely · files are served on demand</p></div>",
            icon("i-folder", ""),
            esc(heading),
            esc(&subtitle)
        ),
    )
}

/// The landing page of a single shared file.
pub fn file_page(token: &str, id: &str, name: &str, mime: Option<&str>, size: i64) -> String {
    let meta: Vec<String> =
        [tma_core::format::share_size(size), kind_label(name, mime)].into_iter().filter(|s| !s.is_empty()).collect();
    page(
        name,
        "",
        &format!(
            "{ICON_SPRITE}<div class=\"wrap\"><div class=\"filecard\"><div class=\"fc-icon\">{}</div><h1>{}</h1><p class=\"sub\">{}</p>\
             <a class=\"dl-all\" href=\"/s/{}/file/{}\" download>{}<span>Download</span></a></div>\
             <p class=\"foot\">Shared securely on demand</p></div>",
            icon(icon_for(file_kind(name, mime)), ""),
            esc(name),
            esc(&meta.join(" · ")),
            esc(token),
            esc(id),
            icon("i-download", "")
        ),
    )
}
