//! Small pure helpers: IDs, input validation, HTTP header values.

use rand::Rng;

const ID_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// A random 16-character ID in the alphabet the API has always used.
pub fn generate_id() -> String {
    let mut rng = rand::rngs::OsRng;
    (0..16).map(|_| ID_ALPHABET[rng.gen_range(0..ID_ALPHABET.len())] as char).collect()
}

/// Whether `id` has the shape of a stored item ID (16 alphanumerics).
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A pragmatic RFC 5321 shape check, as strict as the old validator in practice.
pub fn is_email(value: &str) -> bool {
    if value.len() > 254 || value.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let Some((local, domain)) = value.rsplit_once('@') else { return false };
    if local.is_empty() || local.len() > 64 || local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return false;
    }
    let local_ok = local.chars().all(|c| c.is_alphanumeric() || "!#$%&'*+/=?^_`{|}~.-".contains(c));
    let labels: Vec<&str> = domain.split('.').collect();
    let domain_ok = labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
        && labels.last().is_some_and(|tld| tld.chars().count() >= 2 && tld.chars().all(|c| c.is_alphabetic()));
    local_ok && domain_ok
}

const ICLOUD: &[&str] = &["icloud.com", "me.com"];
const YAHOO: &[&str] = &[
    "rocketmail.com",
    "yahoo.ca",
    "yahoo.co.uk",
    "yahoo.com",
    "yahoo.de",
    "yahoo.fr",
    "yahoo.in",
    "yahoo.it",
    "ymail.com",
];
const YANDEX: &[&str] = &["yandex.ru", "yandex.ua", "yandex.kz", "yandex.com", "yandex.by", "ya.ru"];

fn is_outlook(domain: &str) -> bool {
    const HOTMAIL_TLDS: &[&str] = &[
        "at", "be", "ca", "cl", "co.il", "co.nz", "co.th", "co.uk", "com", "com.ar", "com.au", "com.br", "com.gr",
        "com.mx", "com.pe", "com.tr", "com.vn", "cz", "de", "dk", "es", "fr", "hu", "id", "ie", "in", "it", "jp", "kr",
        "lv", "my", "ph", "pt", "sa", "sg", "sk",
    ];
    const OUTLOOK_TLDS: &[&str] = &[
        "at", "be", "cl", "co.il", "co.nz", "co.th", "com", "com.ar", "com.au", "com.br", "com.gr", "com.pe", "com.tr",
        "com.vn", "cz", "de", "dk", "es", "fr", "hu", "id", "ie", "in", "it", "jp", "kr", "lv", "my", "ph", "pt", "sa",
        "sg", "sk",
    ];
    const LIVE_TLDS: &[&str] = &["be", "co.uk", "com", "com.ar", "com.mx", "de", "es", "eu", "fr", "it", "nl"];
    let tld_of = |prefix: &str| domain.strip_prefix(prefix);
    matches!(domain, "msn.com" | "passport.com")
        || tld_of("hotmail.").is_some_and(|t| HOTMAIL_TLDS.contains(&t))
        || tld_of("outlook.").is_some_and(|t| OUTLOOK_TLDS.contains(&t))
        || tld_of("live.").is_some_and(|t| LIVE_TLDS.contains(&t))
}

/// validator.js `normalizeEmail` with its defaults, so addresses stored by
/// earlier releases keep matching: lowercase, and provider-specific removal of
/// dots and sub-addresses (`john.doe+x@gmail.com` -> `johndoe@gmail.com`).
pub fn normalize_email(email: &str) -> Option<String> {
    let (user, domain) = email.rsplit_once('@')?;
    let domain = domain.to_lowercase();
    let mut user = user.to_string();
    let domain = if domain == "gmail.com" || domain == "googlemail.com" {
        user = user.split('+').next().unwrap_or("").to_string();
        // Single dots go; runs of dots are kept, as validator.js does.
        let mut out = String::new();
        let mut run = 0usize;
        for c in user.chars().chain(std::iter::once('\0')) {
            if c == '.' {
                run += 1;
                continue;
            }
            if run > 1 {
                out.push_str(&".".repeat(run));
            }
            run = 0;
            if c != '\0' {
                out.push(c);
            }
        }
        user = out;
        "gmail.com".to_string()
    } else if ICLOUD.contains(&domain.as_str()) || is_outlook(&domain) {
        user = user.split('+').next().unwrap_or("").to_string();
        domain
    } else if YAHOO.contains(&domain.as_str()) {
        let parts: Vec<&str> = user.split('-').collect();
        user = if parts.len() > 1 { parts[..parts.len() - 1].join("-") } else { parts[0].to_string() };
        domain
    } else if YANDEX.contains(&domain.as_str()) {
        "yandex.ru".to_string()
    } else {
        domain
    };
    if user.is_empty() {
        return None;
    }
    Some(format!("{}@{domain}", user.to_lowercase()))
}

/// RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name.
pub fn content_disposition(disposition: &str, filename: &str) -> String {
    // The fallback must be plain ASCII, or the whole header is invalid and dropped.
    let to_ascii = |s: &str| -> String {
        s.chars().map(|c| if (' '..='~').contains(&c) && c != '"' && c != '\\' { c } else { '_' }).collect()
    };
    let ext = to_ascii(tma_core::names::extname(filename));
    let ascii = to_ascii(filename);
    let ascii = ascii.trim().trim_start_matches('_');
    let legacy = if ascii.is_empty() { "download".to_string() } else { ascii.to_string() };
    let fallback = if legacy.ends_with(&ext) { legacy } else { format!("{legacy}{ext}") };
    let encoded = percent_encoding::utf8_percent_encode(filename, URI_COMPONENT);
    format!("{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

/// The set `encodeURIComponent` escapes.
pub const URI_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent`.
pub fn encode_component(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// A parsed single `Range` header against a known size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    Satisfiable { start: u64, end: u64 },
    Unsatisfiable,
}

/// Parse `bytes=a-b`; multi-range and malformed headers are ignored (serve it all).
pub fn parse_range(header: Option<&str>, size: u64) -> Option<RangeSpec> {
    let value = header?.trim().strip_prefix("bytes=")?;
    let (a, b) = value.split_once('-')?;
    if a.contains(',') || b.contains(',') || (a.is_empty() && b.is_empty()) {
        return None;
    }
    if !a.chars().all(|c| c.is_ascii_digit()) || !b.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if a.is_empty() {
        let suffix: u64 = b.parse().ok()?;
        if suffix == 0 || size == 0 {
            return Some(RangeSpec::Unsatisfiable);
        }
        return Some(RangeSpec::Satisfiable { start: size.saturating_sub(suffix), end: size - 1 });
    }
    let start: u64 = a.parse().ok()?;
    let mut end: u64 = if b.is_empty() { size.saturating_sub(1) } else { b.parse().ok()? };
    if size > 0 && end > size - 1 {
        end = size - 1;
    }
    if size == 0 || start > end || start >= size {
        return Some(RangeSpec::Unsatisfiable);
    }
    Some(RangeSpec::Satisfiable { start, end })
}

/// Escape text for HTML element content and attribute values.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// JSON safe to inline in a `<script>`: `<`, `>`, `&` and line separators are escaped.
pub fn json_for_script(value: &serde_json::Value) -> String {
    let text = value.to_string();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Validate a client-supplied modification time in epoch milliseconds: before
/// 1980 is a broken clock (dropped), a future time is clamped to now.
pub fn client_mtime(value: Option<&str>) -> Option<chrono::DateTime<chrono::Utc>> {
    let ms: i64 = value?.trim().parse().ok()?;
    const MIN_MS: i64 = 315_532_800_000;
    if ms < MIN_MS {
        return None;
    }
    let now = chrono::Utc::now();
    let when = chrono::DateTime::from_timestamp_millis(ms)?;
    Some(if when > now { now } else { when })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        let id = generate_id();
        assert!(is_valid_id(&id));
        assert!(!is_valid_id("short"));
    }

    #[test]
    fn emails() {
        assert!(is_email("alex@northwind.test"));
        assert!(!is_email("no-at-sign"));
        assert!(!is_email("a@b"));
        assert_eq!(normalize_email("John.Doe+x@GMAIL.com").as_deref(), Some("johndoe@gmail.com"));
        assert_eq!(normalize_email("Alex@Northwind.Test").as_deref(), Some("alex@northwind.test"));
        assert_eq!(normalize_email("me+tag@outlook.com").as_deref(), Some("me@outlook.com"));
        assert_eq!(normalize_email("a-b-c@yahoo.com").as_deref(), Some("a-b@yahoo.com"));
        assert_eq!(normalize_email("a..b@gmail.com").as_deref(), Some("a..b@gmail.com"));
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Some(RangeSpec::Satisfiable { start: 0, end: 9 }));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some(RangeSpec::Satisfiable { start: 90, end: 99 }));
        assert_eq!(parse_range(Some("bytes=95-"), 100), Some(RangeSpec::Satisfiable { start: 95, end: 99 }));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Some(RangeSpec::Unsatisfiable));
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), None);
    }

    #[test]
    fn disposition() {
        assert_eq!(
            content_disposition("attachment", "a.txt"),
            "attachment; filename=\"a.txt\"; filename*=UTF-8''a.txt"
        );
        assert!(content_disposition("inline", "résumé.pdf").contains("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"));
        for name in ["x.é", "日本.文書", "a.\"b", "  .tx\t"] {
            let value = content_disposition("attachment", name);
            assert!(axum::http::HeaderValue::from_str(&value).is_ok(), "{name}: {value}");
        }
    }
}
