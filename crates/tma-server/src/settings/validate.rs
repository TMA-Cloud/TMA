//! Validation of settings the first user types in. Pure, so tests cover it directly.

use std::net::IpAddr;

use tma_core::api::ActivitySettings;

/// An OnlyOffice base URL as an absolute http(s) URL with no trailing slash.
/// A bare host ("192.168.1.10" or "ds:8080") is taken as http://, the shape an
/// admin types for a document server on a LAN.
pub fn normalize_onlyoffice_url(raw: &str) -> Result<String, String> {
    let mut value = raw.trim().to_string();
    if value.is_empty() {
        return Err("OnlyOffice URL must not be empty".into());
    }
    let has_scheme = value.find("://").is_some_and(|i| {
        let scheme = &value[..i];
        !scheme.is_empty()
            && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if !has_scheme {
        value = format!("http://{value}");
    }
    let mut url = url::Url::parse(&value).map_err(|_| "Invalid OnlyOffice URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("OnlyOffice URL must use http or https".into());
    }
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

const MAX_KNOWN_PROXIES: usize = 100;

fn is_valid_cidr(value: &str) -> bool {
    value.parse::<ipnet::IpNet>().is_ok() && value.contains('/')
}

fn is_hostname(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

/// Trim, lowercase, de-duplicate and validate proxy IPs, CIDR ranges and hostnames.
pub fn normalize_known_proxies(values: &[String]) -> Result<Vec<String>, String> {
    if values.len() > MAX_KNOWN_PROXIES {
        return Err(format!("At most {MAX_KNOWN_PROXIES} known proxies can be configured"));
    }
    let mut out: Vec<String> = Vec::new();
    for raw in values {
        let entry = raw.trim().to_ascii_lowercase();
        if entry.is_empty() {
            continue;
        }
        if entry.len() > 253 {
            return Err(format!("Known proxy is too long: {entry}"));
        }
        let looks_ipv4 = entry.chars().all(|c| c.is_ascii_digit() || c == '.');
        let ok = entry.parse::<IpAddr>().is_ok() || is_valid_cidr(&entry) || (!looks_ipv4 && is_hostname(&entry));
        if !ok {
            return Err(format!("Invalid proxy IP address, CIDR range, or hostname: {entry}"));
        }
        if !out.contains(&entry) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Resolve proxy entries to networks the server trusts for forwarded headers.
pub async fn resolve_known_proxies(entries: &[String]) -> (Vec<ipnet::IpNet>, Vec<String>) {
    let mut resolved = Vec::new();
    let mut failures = Vec::new();
    for entry in entries {
        if let Ok(ip) = entry.parse::<IpAddr>() {
            resolved.push(ipnet::IpNet::from(ip));
            continue;
        }
        if let Ok(net) = entry.parse::<ipnet::IpNet>() {
            resolved.push(net);
            continue;
        }
        match tokio::net::lookup_host((entry.as_str(), 0)).await {
            Ok(addrs) => {
                let before = resolved.len();
                for addr in addrs {
                    let net = ipnet::IpNet::from(addr.ip());
                    if !resolved.contains(&net) {
                        resolved.push(net);
                    }
                }
                if resolved.len() == before {
                    failures.push(entry.clone());
                }
            }
            Err(_) => failures.push(entry.clone()),
        }
    }
    (resolved, failures)
}

fn whole_number_in(value: i64, (lo, hi): (i32, i32), label: &str) -> Result<i32, String> {
    if value < lo as i64 || value > hi as i64 {
        return Err(format!("{label} must be a whole number from {lo} to {hi}"));
    }
    Ok(value as i32)
}

pub fn normalize_idle_days(value: i64) -> Result<i32, String> {
    whole_number_in(value, ActivitySettings::IDLE_DAYS, "Session idle timeout (days)")
}

pub fn normalize_access_time(enabled: bool, window: i64, flush: i64) -> Result<(bool, i32, i32), String> {
    Ok((
        enabled,
        whole_number_in(window, ActivitySettings::WINDOW_MINUTES, "Access time window (minutes)")?,
        whole_number_in(flush, ActivitySettings::FLUSH_SECONDS, "Write interval (seconds)")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onlyoffice_urls() {
        assert_eq!(normalize_onlyoffice_url("192.168.1.1").as_deref(), Ok("http://192.168.1.1"));
        assert_eq!(normalize_onlyoffice_url("ds:8080/").as_deref(), Ok("http://ds:8080"));
        assert_eq!(
            normalize_onlyoffice_url("https://docs.example.com/sub/").as_deref(),
            Ok("https://docs.example.com/sub")
        );
        assert!(normalize_onlyoffice_url("ftp://x").is_err());
    }

    #[test]
    fn proxies() {
        let ok =
            normalize_known_proxies(&["10.0.0.1".into(), "10.0.0.0/8".into(), "Proxy.Local".into(), "10.0.0.1".into()]);
        assert_eq!(ok, Ok(vec!["10.0.0.1".into(), "10.0.0.0/8".into(), "proxy.local".into()]));
        assert!(normalize_known_proxies(&["999.1.1.1".into()]).is_err());
        assert!(normalize_known_proxies(&["bad host!".into()]).is_err());
    }
}
