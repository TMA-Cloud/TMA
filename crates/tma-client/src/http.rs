//! The HTTP plumbing every endpoint builds on: base URL, headers, cookies and
//! turning failed responses into `ApiError`.

use std::sync::Arc;

use reqwest::{Method, RequestBuilder, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{ApiError, ApiResult};

struct Inner {
    base: String,
    http: reqwest::Client,
    #[cfg(not(target_arch = "wasm32"))]
    jar: Arc<reqwest::cookie::Jar>,
}

/// A handle to one server; cheap to clone.
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// A client for `base_url` with its own cookie jar, identifying as the desktop app.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn new(base_url: &str) -> ApiResult<Self> {
        use reqwest::header::{HeaderMap, HeaderValue};
        let base = normalize_base(base_url)?;
        let jar = Arc::new(reqwest::cookie::Jar::default());
        let mut headers = HeaderMap::new();
        headers.insert("x-requested-with", HeaderValue::from_static("XMLHttpRequest"));
        headers.insert(tma_core::DESKTOP_HEADER_NAME, HeaderValue::from_static(tma_core::DESKTOP_HEADER_VALUE));
        let http = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .default_headers(headers)
            .user_agent(concat!("TMA-Cloud-Desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(ApiError::network)?;
        Ok(Self { inner: Arc::new(Inner { base, http, jar }) })
    }

    /// A client for the page's own origin, sending the page's cookies.
    #[cfg(target_arch = "wasm32")]
    pub fn same_origin() -> ApiResult<Self> {
        let origin = web_sys::window()
            .and_then(|w| w.location().origin().ok())
            .ok_or_else(|| ApiError::local("No page origin"))?;
        let base = normalize_base(&origin)?;
        Ok(Self { inner: Arc::new(Inner { base, http: reqwest::Client::new() }) })
    }

    /// A client for `base_url`; the browser sends that origin's cookies.
    #[cfg(target_arch = "wasm32")]
    pub fn new(base_url: &str) -> ApiResult<Self> {
        let base = normalize_base(base_url)?;
        Ok(Self { inner: Arc::new(Inner { base, http: reqwest::Client::new() }) })
    }

    /// The browser keeps the session cookie itself.
    #[cfg(target_arch = "wasm32")]
    pub fn session_token(&self) -> Option<String> {
        None
    }

    #[cfg(target_arch = "wasm32")]
    pub fn restore_session(&self, _token: &str) {}

    pub fn base_url(&self) -> &str {
        &self.inner.base
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.inner.base)
    }

    /// The session cookie, for keeping a desktop sign-in across restarts.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn session_token(&self) -> Option<String> {
        use reqwest::cookie::CookieStore;
        let url = url::Url::parse(&self.inner.base).ok()?;
        let header = self.inner.jar.cookies(&url)?;
        let text = header.to_str().ok()?;
        text.split(';')
            .map(str::trim)
            .find_map(|c| c.strip_prefix("token="))
            .filter(|t| !t.is_empty())
            .map(String::from)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn restore_session(&self, token: &str) {
        if let Ok(url) = url::Url::parse(&self.inner.base) {
            self.inner.jar.add_cookie_str(&format!("token={token}; Path=/; HttpOnly"), &url);
        }
    }

    pub(crate) fn request(&self, method: Method, path: &str) -> RequestBuilder {
        let builder = self.inner.http.request(method, self.url(path));
        #[cfg(target_arch = "wasm32")]
        let builder = builder.header("x-requested-with", "XMLHttpRequest").fetch_credentials_include();
        builder
    }

    /// Send and turn non-2xx answers into the server's error message.
    pub(crate) async fn send(&self, builder: RequestBuilder) -> ApiResult<Response> {
        let response = builder.send().await.map_err(ApiError::network)?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let fallback = status.canonical_reason().unwrap_or("Request failed").to_string();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Err(ApiError::from_body(status.as_u16(), body, &fallback))
    }

    pub(crate) async fn json<T: DeserializeOwned>(&self, builder: RequestBuilder) -> ApiResult<T> {
        let response = self.send(builder).await?;
        let text = response.text().await.map_err(ApiError::network)?;
        let text = if text.trim().is_empty() { "null" } else { text.as_str() };
        serde_json::from_str(text).map_err(|e| ApiError::local(format!("Unexpected server response: {e}")))
    }

    pub(crate) async fn get<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.json(self.request(Method::GET, path)).await
    }

    pub(crate) async fn post<B: Serialize + ?Sized, T: DeserializeOwned>(&self, path: &str, body: &B) -> ApiResult<T> {
        self.json(self.request(Method::POST, path).json(body)).await
    }

    pub(crate) async fn put<B: Serialize + ?Sized, T: DeserializeOwned>(&self, path: &str, body: &B) -> ApiResult<T> {
        self.json(self.request(Method::PUT, path).json(body)).await
    }

    pub(crate) async fn delete<T: DeserializeOwned>(&self, path: &str) -> ApiResult<T> {
        self.json(self.request(Method::DELETE, path)).await
    }
}

/// `https://host[:port][/prefix]` without a trailing slash.
fn normalize_base(raw: &str) -> ApiResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let url = url::Url::parse(&with_scheme)
        .map_err(|_| ApiError::local("Enter a valid server address, like https://cloud.example.com"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(ApiError::local("The server address must start with http:// or https://"));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Percent-encode one path segment or query value.
pub(crate) fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls() {
        assert_eq!(normalize_base("cloud.example.com/").ok().as_deref(), Some("https://cloud.example.com"));
        assert_eq!(normalize_base("http://10.0.0.2:3000").ok().as_deref(), Some("http://10.0.0.2:3000"));
        assert!(normalize_base("ftp://x").is_err());
    }
}
