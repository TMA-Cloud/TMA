//! Saving an edited document: the document server hands us a URL, we stream it
//! through a fresh data key into a new object, then swap the row to it.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::json;

use crate::crypto::{Encryptor, plaintext_size_to_ciphertext_size};
use crate::services::cleanup::enqueue_object_cleanup;
use crate::services::events::types;
use crate::state::AppState;
use crate::util::generate_id;

pub enum SaveOutcome {
    Saved {
        name: String,
        new_size: i64,
        old_size: i64,
    },
    /// The key's account does not own the file, or it is gone.
    NotFound,
    QuotaExceeded,
}

fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            // 0.0.0.0/8 "this network" and 100.64.0.0/10 shared (CGNAT, Tailscale).
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || a == 0
                || (a == 100 && (b & 0xc0) == 64)
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_internal(IpAddr::V4(v4)),
            // fc00::/7 unique-local and fe80::/10 link-local.
            None => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        },
    }
}

fn host_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    parsed.host_str().map(|h| h.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase())
}

/// Resolves names but drops internal addresses, so a public-looking hostname
/// cannot point the fetch inward; the configured document server is exempt.
struct PublicOnly {
    trusted: Option<String>,
}

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_ascii_lowercase();
        let trusted = self.trusted.as_deref() == Some(host.as_str());
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| trusted || !is_internal(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("{host} resolves only to internal addresses").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// The save URL must be http(s), and internal hosts only when they are the
/// configured document server itself (a common same-network setup).
pub fn is_allowed_download_url(url: &str, onlyoffice_url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = host_of(url) else { return false };
    let trusted = host_of(onlyoffice_url);
    if trusted.as_deref() == Some(host.as_str()) {
        return true;
    }
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    host.parse::<IpAddr>().map(|ip| !is_internal(ip)).unwrap_or(true)
}

#[derive(sqlx::FromRow)]
struct QuotaRow {
    name: String,
    path: Option<String>,
    size: Option<i64>,
    parent_id: Option<String>,
    storage_used: i64,
    storage_reserved: i64,
    storage_limit: Option<i64>,
}

const QUOTA_SQL: &str =
    "SELECT f.name, f.path, f.size, f.parent_id, u.storage_used, u.storage_reserved, u.storage_limit
   FROM files f JOIN users u ON u.id = f.user_id
  WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NULL";

/// Lock the account and file, recheck quota with the new size, and point the row at `key`.
async fn swap(
    state: &AppState,
    owner: &str,
    file_id: &str,
    key: &str,
    size: i64,
    dek: &crate::crypto::WrappedDek,
) -> anyhow::Result<Result<Option<String>, ()>> {
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query_as::<_, QuotaRow>(sqlx::AssertSqlSafe(format!("{QUOTA_SQL} FOR UPDATE OF f, u")))
        .bind(file_id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(QuotaRow {
        path: old_path,
        size: old_size,
        storage_used: used,
        storage_reserved: reserved,
        storage_limit: limit,
        ..
    }) = row
    else {
        anyhow::bail!("File no longer exists")
    };
    if limit.is_some_and(|limit| used + reserved - old_size.unwrap_or(0) + size > limit) {
        return Ok(Err(()));
    }
    sqlx::query("UPDATE files SET path = $1, size = $2, modified = NOW(), dek_wrapped = $3, dek_kek_version = $4, content_version = content_version + 1 WHERE id = $5 AND user_id = $6")
        .bind(key)
        .bind(size)
        .bind(&dek.wrapped)
        .bind(dek.kek_version)
        .bind(file_id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Ok(old_path.filter(|p| p != key)))
}

/// Download the edited document from `url` and make it the file's content.
pub async fn save_document(
    state: &AppState,
    owner: &str,
    file_id: &str,
    url: &str,
    onlyoffice_url: &str,
) -> anyhow::Result<SaveOutcome> {
    let row = sqlx::query_as::<_, QuotaRow>(QUOTA_SQL).bind(file_id).bind(owner).fetch_optional(&state.pool).await?;
    let Some(QuotaRow {
        name,
        path: Some(_),
        size: old_size,
        parent_id: parent,
        storage_used: used,
        storage_reserved: reserved,
        storage_limit: limit,
    }) = row
    else {
        return Ok(SaveOutcome::NotFound);
    };
    let old_size = old_size.unwrap_or(0);
    let allowance = limit.map(|l| (l - used - reserved + old_size).max(0) as u64).unwrap_or(u64::MAX);

    // Redirects are refused so an allowed host cannot bounce the fetch inward;
    // the read timeout stops a stalled body holding the save open forever.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(PublicOnly { trusted: host_of(onlyoffice_url) }))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .tls_danger_accept_invalid_certs(!state.config.onlyoffice_reject_unauthorized)
        .build()?;
    let response = client.get(url).send().await?;
    if response.status() != reqwest::StatusCode::OK {
        anyhow::bail!("Failed to download: {}", response.status().as_u16());
    }

    let key = format!("{}{}", generate_id(), tma_core::names::extname(&name));
    let dek = state.keyring.new_dek()?;
    let mut encryptor = Encryptor::new(&dek.dek)?;
    let max_len = plaintext_size_to_ciphertext_size(allowance.min(crate::settings::MAX_MAX_UPLOAD_BYTES as u64));
    let mut sink = state.storage.upload_sink(&key, max_len).await?;
    let mut body = response.bytes_stream();
    let mut total = 0u64;
    let streamed: anyhow::Result<bool> = async {
        while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            total += chunk.len() as u64;
            if total > allowance {
                return Ok(false);
            }
            for part in encryptor.push(&chunk)? {
                sink.write(&part).await?;
            }
        }
        for part in encryptor.finish()? {
            sink.write(&part).await?;
        }
        Ok(true)
    }
    .await;
    match streamed {
        Ok(true) => {
            sink.finish().await?;
        }
        Ok(false) => {
            sink.abort().await;
            return Ok(SaveOutcome::QuotaExceeded);
        }
        Err(err) => {
            sink.abort().await;
            return Err(err);
        }
    }

    let size = total as i64;
    let replaced = match swap(state, owner, file_id, &key, size, &dek).await {
        Ok(Ok(replaced)) => replaced,
        Ok(Err(())) => {
            enqueue_object_cleanup(state, vec![key], "onlyoffice-failed-metadata-swap").await;
            return Ok(SaveOutcome::QuotaExceeded);
        }
        Err(err) => {
            enqueue_object_cleanup(state, vec![key], "onlyoffice-failed-metadata-swap").await;
            return Err(err);
        }
    };
    if let Some(old) = replaced {
        enqueue_object_cleanup(state, vec![old], "onlyoffice-superseded-object").await;
    }
    state
        .events
        .publish(
            owner,
            types::FILE_UPDATED,
            json!({ "id": file_id, "name": name, "size": size, "parentId": parent, "userId": owner }),
        )
        .await;
    Ok(SaveOutcome::Saved { name, new_size: size, old_size })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_url_policy() {
        let oo = "http://10.0.0.5:8080";
        assert!(is_allowed_download_url("https://docs.example.com/cache/files/x", oo));
        assert!(is_allowed_download_url("http://10.0.0.5:8080/cache/x", oo));
        assert!(!is_allowed_download_url("http://10.0.0.6/cache/x", oo));
        assert!(!is_allowed_download_url("http://127.0.0.1/x", oo));
        assert!(!is_allowed_download_url("http://[::1]/x", oo));
        assert!(!is_allowed_download_url("http://[::ffff:192.168.1.1]/x", oo));
        assert!(!is_allowed_download_url("http://localhost/x", oo));
        assert!(!is_allowed_download_url("file:///etc/passwd", oo));
        assert!(!is_allowed_download_url("http://169.254.169.254/latest", oo));
        assert!(!is_allowed_download_url("http://100.100.1.2/x", oo));
        assert!(!is_allowed_download_url("http://0.1.2.3/x", oo));
        assert!(is_allowed_download_url("http://100.128.0.1/x", oo));
    }

    #[tokio::test]
    async fn resolver_drops_internal_addresses() {
        use reqwest::dns::Resolve;
        use std::str::FromStr;
        let name = || reqwest::dns::Name::from_str("localhost").expect("valid name");
        assert!(PublicOnly { trusted: None }.resolve(name()).await.is_err());
        assert!(PublicOnly { trusted: Some("localhost".into()) }.resolve(name()).await.is_ok());
    }
}
