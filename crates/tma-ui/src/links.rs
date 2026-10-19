//! Where the app points people outside itself: the wiki, the project and its legal pages.

/// The user and admin documentation.
pub const WIKI: &str = "https://tma-cloud.github.io/Wiki/docs";
/// The GitHub organization behind TMA Cloud.
pub const ORG: &str = "https://github.com/TMA-Cloud";
/// Bug reports and feature requests.
pub const ISSUES: &str = "https://github.com/TMA-Cloud/TMA/issues";
/// The licence text.
pub const LICENSE: &str = "https://github.com/TMA-Cloud/TMA/blob/main/LICENSE";

pub fn privacy_policy() -> String {
    format!("{WIKI}/legal/privacy-policy")
}

pub fn terms_of_use() -> String {
    format!("{WIKI}/legal/terms-of-use")
}

/// The release notes of `version` in the wiki's changelog.
pub fn release_notes(version: &str) -> String {
    format!("{WIKI}/changelog/overview?version={version}")
}

/// How to update a server install.
pub fn update_guide() -> String {
    format!("{WIKI}/guides/operations/updating")
}
