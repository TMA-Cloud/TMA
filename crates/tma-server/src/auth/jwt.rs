//! Auth tokens (HS256 JWTs) and the cookies that carry them.

use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    #[serde(default)]
    pub iat: i64,
    pub exp: i64,
}

fn validation() -> Validation {
    let mut v = Validation::new(Algorithm::HS256);
    v.leeway = 5;
    v.validate_aud = false;
    v
}

/// Mint a session token valid for `ttl_secs` (the idle window; renewed while active).
pub fn issue(
    secret: &str,
    user_id: &str,
    version: i32,
    session_id: Option<&str>,
    ttl_secs: i64,
) -> anyhow::Result<String> {
    let now = Utc::now().timestamp();
    let claims = Claims {
        id: user_id.into(),
        v: Some(version),
        sid: session_id.map(String::from),
        iat: now,
        exp: now + ttl_secs,
    };
    Ok(jsonwebtoken::encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

pub fn verify(secret: &str, token: &str) -> Option<Claims> {
    jsonwebtoken::decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &validation())
        .ok()
        .map(|d| d.claims)
}

/// Sign any claims with HS256 (OnlyOffice tokens, viewer and download tickets).
pub fn sign_value<T: Serialize>(secret: &str, claims: &T) -> anyhow::Result<String> {
    Ok(jsonwebtoken::encode(&Header::new(Algorithm::HS256), claims, &EncodingKey::from_secret(secret.as_bytes()))?)
}

/// Verify an HS256 token whose claims may lack `exp`.
pub fn verify_value(secret: &str, token: &str, require_exp: bool) -> Option<serde_json::Value> {
    let mut v = validation();
    if !require_exp {
        v.required_spec_claims.clear();
        v.validate_exp = false;
    }
    jsonwebtoken::decode::<serde_json::Value>(token, &DecodingKey::from_secret(secret.as_bytes()), &v)
        .ok()
        .map(|d| d.claims)
}

fn http_date(at: chrono::DateTime<Utc>) -> String {
    at.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// A `Set-Cookie` value for an HttpOnly, SameSite=Lax cookie.
pub fn cookie(name: &str, value: &str, max_age_secs: i64, secure: bool) -> String {
    let expires = http_date(Utc::now() + chrono::Duration::seconds(max_age_secs));
    format!(
        "{name}={value}; Max-Age={max_age_secs}; Path=/; Expires={expires}; HttpOnly{}; SameSite=Lax",
        if secure { "; Secure" } else { "" }
    )
}

/// A `Set-Cookie` value that removes a cookie.
pub fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
}

/// A cookie's value from a `Cookie` header.
pub fn read_cookie(header: Option<&str>, name: &str) -> Option<String> {
    header?.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == name).then(|| percent_encoding::percent_decode_str(v.trim()).decode_utf8_lossy().into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let token = issue("s", "user1234567890ab", 3, Some("sid"), 60).unwrap();
        let claims = verify("s", &token).unwrap();
        assert_eq!(claims.id, "user1234567890ab");
        assert_eq!(claims.v, Some(3));
        assert!(verify("other", &token).is_none());
        assert_eq!(read_cookie(Some("a=1; token=abc; b=2"), "token").as_deref(), Some("abc"));
    }
}
