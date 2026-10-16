//! Google sign-in: the OAuth client the first user configures (secret sealed
//! under the master key), the authorization-code flow with state and PKCE, and
//! ID token verification against Google's published keys.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use serde::Deserialize;
use sqlx::PgPool;
use tma_core::api::{GoogleAuthInput, GoogleAuthSummary};
use tokio::sync::RwLock;

use crate::crypto::{GOOGLE_SECRET, Keyring, open_secret, seal_secret};
use crate::error::DomainError;

pub const CALLBACK_PATH: &str = "/api/google/callback";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const CERTS_ENDPOINT: &str = "https://www.googleapis.com/oauth2/v3/certs";
const CONFIG_TTL: Duration = Duration::from_secs(15);

#[derive(Clone, PartialEq, Eq)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub version: i32,
}

type Cached<T> = Arc<RwLock<(Option<T>, Option<Instant>)>>;

/// In-memory copies of the decrypted client and of Google's signing keys.
#[derive(Clone, Default)]
pub struct GoogleConfigCache {
    config: Cached<GoogleConfig>,
    jwks: Cached<serde_json::Value>,
}

#[derive(sqlx::FromRow)]
struct GoogleRow {
    google_client_id: Option<String>,
    google_client_secret_encrypted: Option<Vec<u8>>,
    google_client_secret_kek_version: Option<i32>,
    google_redirect_uri: Option<String>,
    google_updated_at: Option<chrono::DateTime<chrono::Utc>>,
    google_config_version: i32,
}

const SELECT_GOOGLE: &str = "SELECT google_client_id, google_client_secret_encrypted, google_client_secret_kek_version,
  google_redirect_uri, google_updated_at, google_config_version FROM app_settings WHERE id = 'app_settings'";

async fn read_row<'e, E: sqlx::PgExecutor<'e>>(db: E, for_update: bool) -> Result<Option<GoogleRow>> {
    let sql = format!("{SELECT_GOOGLE}{}", if for_update { " FOR UPDATE" } else { "" });
    Ok(sqlx::query_as::<_, GoogleRow>(sqlx::AssertSqlSafe(sql)).fetch_optional(db).await?)
}

pub async fn load(pool: &PgPool, keyring: &Keyring) -> Result<Option<GoogleConfig>> {
    let Some(row) = read_row(pool, false).await? else { return Ok(None) };
    let (Some(client_id), Some(sealed), Some(kv), Some(redirect_uri)) = (
        row.google_client_id,
        row.google_client_secret_encrypted,
        row.google_client_secret_kek_version,
        row.google_redirect_uri,
    ) else {
        return Ok(None);
    };
    let client_secret = open_secret(&sealed, &GOOGLE_SECRET, &client_id, keyring.kek(kv)?)?;
    Ok(Some(GoogleConfig { client_id, client_secret, redirect_uri, version: row.google_config_version }))
}

impl GoogleConfigCache {
    /// The active client, or `None` when Google sign-in is off. A secret that no
    /// longer decrypts turns sign-in off instead of failing every login page.
    pub async fn get(&self, pool: &PgPool, keyring: &Keyring) -> Option<GoogleConfig> {
        {
            let guard = self.config.read().await;
            if guard.1.is_some_and(|at| at.elapsed() < CONFIG_TTL) {
                return guard.0.clone();
            }
        }
        let config = load(pool, keyring).await.unwrap_or_else(|err| {
            tracing::error!(error = %err, "[GoogleAuth] Saved Google sign-in settings could not be read");
            None
        });
        *self.config.write().await = (config.clone(), Some(Instant::now()));
        config
    }

    pub async fn invalidate(&self) {
        self.config.write().await.1 = None;
    }

    async fn certs(&self, http: &reqwest::Client) -> Result<serde_json::Value> {
        {
            let guard = self.jwks.read().await;
            if let (Some(keys), Some(at)) = (&guard.0, guard.1)
                && at.elapsed() < Duration::from_secs(3600)
            {
                return Ok(keys.clone());
            }
        }
        let keys: serde_json::Value = http.get(CERTS_ENDPOINT).send().await?.error_for_status()?.json().await?;
        *self.jwks.write().await = (Some(keys.clone()), Some(Instant::now()));
        Ok(keys)
    }
}

pub async fn summary(pool: &PgPool) -> Result<GoogleAuthSummary> {
    let row = read_row(pool, false).await?;
    let version = row.as_ref().map(|r| r.google_config_version).unwrap_or(0);
    match row {
        Some(r) if r.google_client_id.is_some() => Ok(GoogleAuthSummary {
            configured: true,
            version,
            client_id: r.google_client_id,
            redirect_uri: r.google_redirect_uri,
            updated_at: r.google_updated_at,
        }),
        _ => Ok(GoogleAuthSummary { configured: false, version, ..Default::default() }),
    }
}

fn bad(m: impl Into<String>) -> DomainError {
    DomainError::BadRequest(m.into())
}

fn normalize_redirect_uri(raw: &str) -> Result<String, DomainError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(bad("Redirect URI is required"));
    }
    if value.len() > 2048 {
        return Err(bad("Redirect URI is too long"));
    }
    let url = url::Url::parse(value).map_err(|_| {
        bad(format!("Redirect URI must be a full URL, such as https://cloud.example.com{CALLBACK_PATH}"))
    })?;
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1");
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(bad("Redirect URI must use https:// (http:// is allowed only for localhost)"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("Redirect URI must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("Redirect URI must not contain a query string or fragment"));
    }
    if host.parse::<std::net::IpAddr>().is_ok() && !loopback {
        return Err(bad("Google does not accept an IP address in a redirect URI; use a domain name"));
    }
    if !loopback && !host.contains('.') {
        return Err(bad("Redirect URI must use a public domain name"));
    }
    if url.path() != CALLBACK_PATH {
        return Err(bad(format!("Redirect URI must end with {CALLBACK_PATH}")));
    }
    Ok(format!("{}{CALLBACK_PATH}", url.origin().ascii_serialization()))
}

/// Admin input to the stored shape; a blank secret keeps the saved one for the same client.
pub fn normalize(input: &GoogleAuthInput, current: Option<&GoogleConfig>) -> Result<GoogleConfig, DomainError> {
    let client_id = input.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(bad("Client ID is required"));
    }
    let id_ok = client_id.len() <= 255
        && client_id.ends_with(".apps.googleusercontent.com")
        && client_id.split_once('-').is_some_and(|(num, rest)| {
            !num.is_empty()
                && num.chars().all(|c| c.is_ascii_digit())
                && rest
                    .trim_end_matches(".apps.googleusercontent.com")
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        });
    if !id_ok {
        return Err(bad("Client ID must look like 123456789-abc123.apps.googleusercontent.com"));
    }
    let secret_in = input.client_secret.as_deref().map(str::trim).unwrap_or("");
    let client_secret = if secret_in.is_empty() {
        match current {
            Some(cur) if cur.client_id == client_id => cur.client_secret.clone(),
            _ => return Err(bad("Client secret is required")),
        }
    } else if (8..=256).contains(&secret_in.len()) && secret_in.chars().all(|c| ('\x21'..='\x7e').contains(&c)) {
        secret_in.to_string()
    } else {
        return Err(bad("Client secret is not valid"));
    };
    Ok(GoogleConfig {
        client_id,
        client_secret,
        redirect_uri: normalize_redirect_uri(&input.redirect_uri)?,
        version: 0,
    })
}

/// Check a client before saving it by redeeming a code that cannot exist: a bad
/// ID or secret answers `invalid_client`, a valid client `invalid_grant`.
pub async fn probe(http: &reqwest::Client, config: &GoogleConfig) -> Result<(), (u16, String)> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", "tma-cloud-credentials-check"),
        ("client_id", config.client_id.as_str()),
        ("client_secret", config.client_secret.as_str()),
        ("redirect_uri", config.redirect_uri.as_str()),
    ];
    let response =
        http.post(TOKEN_ENDPOINT).form(&form).timeout(Duration::from_secs(10)).send().await.map_err(|err| {
            tracing::warn!(error = %err, "[GoogleAuth] Could not reach Google to check the client");
            (502, "Could not reach Google to check the client ID and secret. Try again.".to_string())
        })?;
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    match body.get("error").and_then(|e| e.as_str()) {
        Some("invalid_grant") => Ok(()),
        Some("invalid_client" | "unauthorized_client") => {
            Err((400, "Google rejected the client ID or secret. Copy both again from Google Cloud.".into()))
        }
        _ => Err((502, "Google gave an unexpected answer while checking the client. Try again.".into())),
    }
}

/// Write the client as a compare-and-swap on the config version; `None` clears it.
pub async fn save(
    pool: &PgPool,
    keyring: &Keyring,
    config: Option<&GoogleConfig>,
    user_id: &str,
    expected: Option<i32>,
) -> Result<i32> {
    let mut tx = pool.begin().await?;
    crate::settings::verify_first_user(&mut tx, user_id, "configure Google sign-in").await?;
    let current = read_row(&mut *tx, true).await?.context("App settings not found")?;
    if expected.is_some_and(|e| e != current.google_config_version) {
        return Err(DomainError::Conflict(
            "Google sign-in settings were changed by another session. Reload and try again.".into(),
        )
        .into());
    }
    let sealed = match config {
        Some(c) => Some((
            seal_secret(&c.client_secret, &GOOGLE_SECRET, &c.client_id, keyring.primary_kek()?)?,
            keyring.primary_version(),
        )),
        None => None,
    };
    let version: i32 = sqlx::query_scalar(
        "UPDATE app_settings SET google_client_id = $1, google_client_secret_encrypted = $2, google_client_secret_kek_version = $3,
           google_redirect_uri = $4, google_updated_at = NOW(), google_config_version = google_config_version + 1, updated_at = NOW()
         WHERE id = 'app_settings' RETURNING google_config_version",
    )
    .bind(config.map(|c| c.client_id.clone()))
    .bind(sealed.as_ref().map(|s| s.0.clone()))
    .bind(sealed.as_ref().map(|s| s.1))
    .bind(config.map(|c| c.redirect_uri.clone()))
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(version)
}

/// Rewrap the stored client secret under the primary KEK after a rotation.
pub async fn rewrap_secret(pool: &PgPool, keyring: &Keyring) -> Result<bool> {
    let mut tx = pool.begin().await?;
    let Some(row) = read_row(&mut *tx, true).await? else { return Ok(false) };
    let (Some(id), Some(sealed), Some(kv)) =
        (row.google_client_id, row.google_client_secret_encrypted, row.google_client_secret_kek_version)
    else {
        return Ok(false);
    };
    let Some(resealed) = crate::crypto::reseal(&sealed, &GOOGLE_SECRET, &id, kv, keyring)? else { return Ok(false) };
    sqlx::query("UPDATE app_settings SET google_client_secret_encrypted = $1, google_client_secret_kek_version = $2 WHERE id = 'app_settings'")
        .bind(resealed)
        .bind(keyring.primary_version())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce_pair() -> (String, String) {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let verifier = b64.encode(crate::crypto::random_bytes::<32>());
    let challenge = b64.encode(crate::crypto::sha256(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn auth_url(config: &GoogleConfig, state: &str, challenge: &str) -> String {
    let enc = crate::util::encode_component;
    format!(
        "{AUTH_ENDPOINT}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge_method=S256&code_challenge={}&prompt=select_account",
        enc(&config.client_id),
        enc(&config.redirect_uri),
        enc("openid profile email"),
        enc(state),
        enc(challenge)
    )
}

/// The verified identity from a Google ID token.
#[derive(Debug, Deserialize)]
pub struct GoogleIdentity {
    pub sub: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Redeem the code (with the PKCE verifier) and verify the returned ID token.
pub async fn exchange(
    http: &reqwest::Client,
    cache: &GoogleConfigCache,
    config: &GoogleConfig,
    code: &str,
    verifier: &str,
) -> Result<GoogleIdentity> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", config.client_id.as_str()),
        ("client_secret", config.client_secret.as_str()),
        ("redirect_uri", config.redirect_uri.as_str()),
        ("code_verifier", verifier),
    ];
    let tokens: serde_json::Value =
        http.post(TOKEN_ENDPOINT).form(&form).send().await?.error_for_status()?.json().await?;
    let id_token =
        tokens.get("id_token").and_then(|t| t.as_str()).ok_or_else(|| anyhow!("Google returned no ID token"))?;
    let header = jsonwebtoken::decode_header(id_token)?;
    let kid = header.kid.ok_or_else(|| anyhow!("ID token has no key id"))?;
    let certs = cache.certs(http).await?;
    let jwk_value = certs
        .get("keys")
        .and_then(|k| k.as_array())
        .and_then(|keys| keys.iter().find(|k| k.get("kid").and_then(|v| v.as_str()) == Some(kid.as_str())))
        .ok_or_else(|| anyhow!("Unknown Google signing key"))?;
    let jwk: jsonwebtoken::jwk::Jwk = serde_json::from_value(jwk_value.clone())?;
    let key = jsonwebtoken::DecodingKey::from_jwk(&jwk)?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[config.client_id.as_str()]);
    validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);
    let data = jsonwebtoken::decode::<GoogleIdentity>(id_token, &key, &validation)?;
    if data.claims.sub.is_empty() {
        bail!("ID token has no subject");
    }
    Ok(data.claims)
}
