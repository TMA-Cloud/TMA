//! `/api/user`: instance settings the first user manages, and the account's storage figures.

mod config;
mod integrations;
mod users;

use axum::Router;
use axum::routing::{get, post, put};

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/signup-status", get(config::signup_status))
        .route("/signup-toggle", post(config::toggle_signup))
        .route("/all", get(users::list))
        .route("/storage", get(users::storage_usage))
        .route("/storage-status", get(integrations::storage_status))
        .route("/storage-config", get(integrations::storage_config).put(integrations::save_storage_config))
        .route("/storage-config/test", post(integrations::test_storage_config))
        .route(
            "/google-auth-config",
            get(integrations::google_config)
                .put(integrations::save_google_config)
                .delete(integrations::clear_google_config),
        )
        .route("/onlyoffice-configured", get(config::onlyoffice_configured))
        .route("/onlyoffice-config", get(config::onlyoffice_config).put(config::save_onlyoffice_config))
        .route("/share-base-url-config", get(config::share_base_url).put(config::save_share_base_url))
        .route("/max-upload-size-config", get(config::max_upload).put(config::save_max_upload))
        .route("/known-proxies-config", get(config::known_proxies).put(config::save_known_proxies))
        .route("/hide-file-extensions-config", get(config::hide_extensions).put(config::save_hide_extensions))
        .route("/electron-only-access-config", get(config::desktop_only).put(config::save_desktop_only))
        .route("/cloud-drive-config", get(config::cloud_drive).put(config::save_cloud_drive))
        .route("/password-change-config", get(config::password_change).put(config::save_password_change))
        .route("/activity-config", get(config::activity))
        .route("/session-timeout-config", put(config::save_session_timeout))
        .route("/access-time-config", put(config::save_access_time))
        .route("/storage-limit", put(users::set_storage_limit))
        .route("/client-heartbeat", post(users::client_heartbeat))
        .route("/active-clients", get(users::active_clients))
        .route("/orphans", get(users::orphans))
        .route("/orphans/delete", post(users::delete_orphans))
}
