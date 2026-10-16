//! The storage bucket form: provider presets, the R2 endpoint built from an
//! account ID, checks the server would make anyway, and the API shape.

use tma_core::api::{StorageSettingsInput, StorageSettingsSummary};

pub const PROVIDERS: [(&str, &str); 3] =
    [("r2", "Cloudflare R2"), ("aws", "Amazon S3"), ("s3", "Other S3-compatible (RustFS, MinIO, Ceph…)")];

pub const JURISDICTIONS: [(&str, &str); 3] = [("default", "Default"), ("eu", "European Union"), ("fedramp", "FedRAMP")];

/// Short provider name for the status chip.
pub fn provider_label(provider: &str) -> &'static str {
    match provider {
        "r2" => "Cloudflare R2",
        "aws" => "Amazon S3",
        _ => "S3-compatible",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BucketForm {
    pub provider: String,
    pub account_id: String,
    pub jurisdiction: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub force_path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl Default for BucketForm {
    fn default() -> Self {
        Self {
            provider: "r2".into(),
            account_id: String::new(),
            jurisdiction: "default".into(),
            endpoint: String::new(),
            region: String::new(),
            bucket: String::new(),
            force_path_style: true,
            access_key_id: String::new(),
            secret_access_key: String::new(),
        }
    }
}

fn is_account_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn r2_endpoint(account_id: &str, jurisdiction: &str) -> String {
    let id = account_id.trim().to_lowercase();
    match jurisdiction {
        "eu" | "fedramp" => format!("https://{id}.{jurisdiction}.r2.cloudflarestorage.com"),
        _ => format!("https://{id}.r2.cloudflarestorage.com"),
    }
}

/// The account ID and jurisdiction back out of an R2 endpoint.
pub fn parse_r2_endpoint(endpoint: &str) -> Option<(String, String)> {
    let host = endpoint.strip_prefix("https://")?.strip_suffix(".r2.cloudflarestorage.com")?;
    let (id, jurisdiction) = match host.split_once('.') {
        Some((id, j)) if j.eq_ignore_ascii_case("eu") || j.eq_ignore_ascii_case("fedramp") => (id, j.to_lowercase()),
        Some(_) => return None,
        None => (host, "default".into()),
    };
    is_account_id(id).then(|| (id.to_lowercase(), jurisdiction))
}

impl BucketForm {
    /// Saved settings as an editable form; credentials start blank, meaning "keep".
    pub fn from_summary(summary: &StorageSettingsSummary) -> Self {
        let Some(provider) = summary.provider.clone().filter(|_| summary.configured) else { return Self::default() };
        let endpoint = summary.endpoint.clone().unwrap_or_default();
        let r2 = if provider == "r2" { parse_r2_endpoint(&endpoint) } else { None };
        Self {
            account_id: r2.as_ref().map(|r| r.0.clone()).unwrap_or_default(),
            jurisdiction: r2.map(|r| r.1).unwrap_or_else(|| "default".into()),
            region: summary.region.clone().filter(|r| r != "auto").unwrap_or_default(),
            bucket: summary.bucket.clone().unwrap_or_default(),
            force_path_style: summary.force_path_style.unwrap_or(true),
            provider,
            endpoint,
            ..Self::default()
        }
    }

    pub fn to_input(&self, expected_version: Option<i32>) -> StorageSettingsInput {
        let endpoint = if self.provider == "r2" && !self.account_id.trim().is_empty() {
            r2_endpoint(&self.account_id, &self.jurisdiction)
        } else {
            self.endpoint.trim().to_string()
        };
        let some = |s: &str| Some(s.trim().to_string()).filter(|s| !s.is_empty());
        StorageSettingsInput {
            provider: self.provider.clone(),
            endpoint: some(&endpoint),
            region: some(&self.region),
            bucket: some(&self.bucket),
            force_path_style: Some(self.force_path_style),
            access_key_id: some(&self.access_key_id),
            secret_access_key: some(&self.secret_access_key),
            expected_version,
        }
    }

    /// What the server would reject anyway, caught before a round trip.
    pub fn problem(&self, has_saved_credentials: bool) -> Option<&'static str> {
        if self.provider == "r2" && !is_account_id(self.account_id.trim()) {
            return Some("Enter your 32-character Cloudflare account ID");
        }
        if self.provider == "s3" && self.endpoint.trim().is_empty() {
            return Some("Enter the endpoint URL");
        }
        if self.provider == "aws" && self.region.trim().is_empty() {
            return Some("Enter the AWS region, such as eu-west-1");
        }
        if self.bucket.trim().is_empty() {
            return Some("Enter the bucket name");
        }
        let (key, secret) = (!self.access_key_id.trim().is_empty(), !self.secret_access_key.trim().is_empty());
        if !has_saved_credentials && !(key && secret) {
            return Some("Enter the access key ID and secret access key");
        }
        if secret && !key {
            return Some("Enter the access key ID that belongs to this secret");
        }
        None
    }
}

/// A server check step as a reader would name it.
pub fn check_label(step: &str) -> &str {
    match step {
        "connect" => "Reach the bucket",
        "list" => "List objects",
        "write" => "Write an object",
        "read" => "Read it back",
        "delete" => "Delete it",
        "existing-files" => "Find existing files",
        other => other,
    }
}

/// The outcome of a test or save, shown under the form.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckResult {
    pub ok: bool,
    pub message: String,
    pub step: Option<String>,
    pub checks: Vec<String>,
}

impl CheckResult {
    pub fn failed(err: &tma_client::ApiError) -> Self {
        let step = err.body.get("step").and_then(serde_json::Value::as_str).map(String::from);
        Self { ok: false, message: err.message.clone(), step, checks: Vec::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn r2_endpoints_round_trip() {
        assert_eq!(r2_endpoint(ID, "default"), format!("https://{ID}.r2.cloudflarestorage.com"));
        assert_eq!(r2_endpoint(ID, "eu"), format!("https://{ID}.eu.r2.cloudflarestorage.com"));
        assert_eq!(parse_r2_endpoint(&r2_endpoint(ID, "fedramp")), Some((ID.into(), "fedramp".into())));
        assert_eq!(parse_r2_endpoint("https://s3.example.com"), None);
        assert_eq!(parse_r2_endpoint("https://short.r2.cloudflarestorage.com"), None);
    }

    #[test]
    fn saved_settings_become_a_form() {
        let summary = StorageSettingsSummary {
            configured: true,
            provider: Some("r2".into()),
            endpoint: Some(r2_endpoint(ID, "eu")),
            region: Some("auto".into()),
            bucket: Some("files".into()),
            ..Default::default()
        };
        let form = BucketForm::from_summary(&summary);
        assert_eq!((form.account_id.as_str(), form.jurisdiction.as_str(), form.region.as_str()), (ID, "eu", ""));
        let input = form.to_input(Some(3));
        assert_eq!(input.endpoint, Some(r2_endpoint(ID, "eu")));
        assert_eq!((input.access_key_id, input.expected_version), (None, Some(3)));
        assert_eq!(BucketForm::from_summary(&StorageSettingsSummary::default()), BucketForm::default());
    }

    #[test]
    fn problems_are_caught_before_sending() {
        let mut form = BucketForm::default();
        assert_eq!(form.problem(false), Some("Enter your 32-character Cloudflare account ID"));
        form.account_id = ID.into();
        assert_eq!(form.problem(false), Some("Enter the bucket name"));
        form.bucket = "files".into();
        assert_eq!(form.problem(false), Some("Enter the access key ID and secret access key"));
        assert_eq!(form.problem(true), None);
        form.secret_access_key = "s".into();
        assert_eq!(form.problem(true), Some("Enter the access key ID that belongs to this secret"));
        form.provider = "aws".into();
        assert_eq!(form.problem(true), Some("Enter the AWS region, such as eu-west-1"));
        form.provider = "s3".into();
        assert_eq!(form.problem(true), Some("Enter the endpoint URL"));
        assert_eq!(check_label("write"), "Write an object");
    }
}
