//! `/api/files`: browsing is open to every member of an account; anything that
//! changes files needs an explicit grant, checked before an upload body is read.

mod download;
mod events;
mod list;
mod locks;
mod ops;
mod progress;
mod share;
mod upload;

pub use download::bulk_form;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    let uploads = Router::new()
        .route("/upload", post(upload::single))
        .route("/upload/bulk", post(upload::bulk))
        .route("/{id}/replace", post(upload::replace))
        .route("/{id}/derived", post(upload::derived))
        .layer(DefaultBodyLimit::disable());
    Router::new()
        .route("/events", get(events::stream))
        .route("/", get(list::folder))
        .route("/stats", get(list::stats))
        .route("/{id}/info", get(list::info))
        .route("/search", get(list::search))
        .route("/recent", get(list::recent))
        .route("/starred", get(list::starred))
        .route("/shared", get(list::shared))
        .route("/trash", get(list::trash))
        .route("/jobs/{job_id}", get(list::job))
        .route("/download/bulk", post(download::bulk))
        .route("/download/bulk/ticket", post(download::bulk_ticket))
        .route("/{id}/download", get(download::single))
        .route("/{id}/lock", post(locks::take).delete(locks::give_up))
        .route("/folder", post(ops::add_folder))
        .route("/upload/check", post(upload::check))
        .route("/copy", post(ops::copy))
        .route("/move", post(ops::move_items))
        .route("/rename", post(ops::rename))
        .route("/star", post(ops::star))
        .route("/share", post(share::share))
        .route("/link-parent-share", post(share::link_parent))
        .route("/share/links", post(share::links))
        .route("/delete", post(ops::trash))
        .route("/trash/restore", post(ops::restore))
        .route("/trash/delete", post(ops::delete_forever))
        .route("/trash/empty", post(ops::empty_trash))
        .merge(uploads)
}
