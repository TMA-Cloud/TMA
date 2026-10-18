//! Pure Settings logic: number ranges, size units, labels, the admin user list
//! and the backup-codes file. Views stay thin and these stay testable.

use tma_core::api::{ActiveClient, AdminUser};
use tma_core::permissions::PermissionInfo;

pub const MB: i64 = 1024 * 1024;
pub const GB: i64 = 1024 * MB;
pub const TB: i64 = 1024 * GB;

/// The upload limit the server accepts, per file.
pub const UPLOAD_LIMIT: (i64, i64) = (MB, 100 * GB);

/// A whole number typed into a field, checked against its inclusive range.
pub fn whole_number(text: &str, (min, max): (i32, i32), label: &str) -> Result<i32, String> {
    let text = text.trim();
    text.parse::<i32>()
        .ok()
        .filter(|v| text.bytes().all(|b| b.is_ascii_digit()) && (min..=max).contains(v))
        .ok_or_else(|| format!("{label} must be a whole number from {min} to {max}"))
}

pub fn plural(count: i64, unit: &str) -> String {
    format!("{count} {unit}{}", if count == 1 { "" } else { "s" })
}

/// How a stored access time follows reads, in a few words.
pub fn access_time_label(enabled: bool, window_minutes: i32) -> String {
    match (enabled, window_minutes) {
        (false, _) => "Off".into(),
        (true, 0) => "Every read".into(),
        (true, m) if m % 60 == 0 => format!("At most every {}", plural(i64::from(m / 60), "hour")),
        (true, m) => format!("At most every {}", plural(i64::from(m), "minute")),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub enum Unit {
    Mb,
    #[default]
    Gb,
    Tb,
}

impl Unit {
    pub const ALL: [Unit; 3] = [Unit::Mb, Unit::Gb, Unit::Tb];

    pub fn label(self) -> &'static str {
        match self {
            Unit::Mb => "MB",
            Unit::Gb => "GB",
            Unit::Tb => "TB",
        }
    }

    pub fn bytes(self) -> i64 {
        match self {
            Unit::Mb => MB,
            Unit::Gb => GB,
            Unit::Tb => TB,
        }
    }
}

/// Up to three decimals, without trailing zeros ("1.5", "10").
fn trim_number(value: f64) -> String {
    let s = format!("{:.3}", (value * 1000.0).round() / 1000.0);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A byte count as the number and unit to edit it in; `top` is the largest unit offered.
pub fn split_size(bytes: Option<i64>, top: Unit) -> (String, Unit) {
    let Some(bytes) = bytes.filter(|b| *b > 0) else { return (String::new(), Unit::Gb) };
    let unit = Unit::ALL.into_iter().rev().find(|u| *u <= top && bytes >= u.bytes()).unwrap_or(Unit::Mb);
    (trim_number(bytes as f64 / unit.bytes() as f64), unit)
}

/// A positive size typed in a unit, as bytes.
pub fn size_bytes(text: &str, unit: Unit) -> Option<i64> {
    let value = text.trim().parse::<f64>().ok().filter(|v| v.is_finite() && *v > 0.0)?;
    let bytes = (value * unit.bytes() as f64).round();
    (bytes >= 1.0 && bytes <= i64::MAX as f64).then_some(bytes as i64)
}

/// The upload limit as a short label: "10 GB", "512 MB".
pub fn upload_limit_label(bytes: i64) -> String {
    let (number, unit) = split_size(Some(bytes), Unit::Gb);
    format!("{number} {}", unit.label())
}

/// Convert the number in a size field when its unit changes, keeping the amount.
pub fn convert_size(text: &str, from: Unit, to: Unit) -> String {
    match size_bytes(text, from) {
        Some(bytes) => trim_number(bytes as f64 / to.bytes() as f64),
        None => text.to_string(),
    }
}

/// Proxy entries from a box that takes one per line or comma-separated.
pub fn parse_proxies(text: &str) -> Vec<String> {
    text.split([',', '\n']).map(str::trim).filter(|e| !e.is_empty()).map(String::from).collect()
}

/// The redirect URI Google must be told, for a site address.
pub fn redirect_uri_for(origin: &str) -> String {
    format!("{}/api/google/callback", origin.trim_end_matches('/'))
}

/// "Full access", "Browse only", or the first labels and a count of the rest.
pub fn permission_summary(granted: &[String], available: &[PermissionInfo]) -> String {
    if !available.is_empty() && available.iter().all(|p| granted.contains(&p.key)) {
        return "Full access".into();
    }
    let labels: Vec<&str> = available.iter().filter(|p| granted.contains(&p.key)).map(|p| p.label.as_str()).collect();
    match labels.len() {
        0 => "Browse only".into(),
        1 | 2 => labels.join(", "),
        n => format!("{} +{}", labels[..2].join(", "), n - 2),
    }
}

/// The kind of device a browser's user agent describes.
pub fn device_label(user_agent: &str) -> &'static str {
    let has = |s: &str| user_agent.contains(s);
    if has("Mobile") || has("Android") || has("iPhone") {
        "Mobile"
    } else if has("TMA-Cloud-Desktop") {
        "Desktop app"
    } else if has("Windows") {
        "Windows"
    } else if has("Mac") {
        "Mac"
    } else if has("Linux") {
        "Linux"
    } else {
        "Unknown device"
    }
}

/// A desktop client's platform as people say it.
pub fn platform_label(platform: Option<&str>) -> String {
    match platform {
        None | Some("") => "Unknown".into(),
        Some("win32" | "windows") => "Windows".into(),
        Some("darwin" | "macos") => "macOS".into(),
        Some("linux") => "Linux".into(),
        Some(other) => other.to_string(),
    }
}

/// Each app version with how many clients run it, most common first.
pub fn version_groups(clients: &[ActiveClient]) -> Vec<(String, usize)> {
    let mut groups: Vec<(String, usize)> = Vec::new();
    for client in clients {
        match groups.iter_mut().find(|(v, _)| *v == client.app_version) {
            Some((_, n)) => *n += 1,
            None => groups.push((client.app_version.clone(), 1)),
        }
    }
    groups.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    groups
}

/// Rows for the admin user list: each account, then its sub-users, as
/// (user index, owner index). A sub-user whose owner is missing stands alone.
pub fn account_rows(users: &[AdminUser]) -> Vec<(usize, Option<usize>)> {
    let is_owner = |u: &AdminUser| match &u.parent_user_id {
        None => true,
        Some(parent) => !users.iter().any(|o| &o.id == parent),
    };
    let mut rows = Vec::new();
    for (i, owner) in users.iter().enumerate().filter(|(_, u)| is_owner(u)) {
        rows.push((i, None));
        for (j, _) in users.iter().enumerate().filter(|(_, u)| u.parent_user_id.as_ref() == Some(&owner.id)) {
            rows.push((j, Some(i)));
        }
    }
    rows
}

/// MFA adoption across the listed users: (enabled, disabled, percent).
pub fn mfa_adoption(users: &[AdminUser]) -> (usize, usize, u32) {
    let enabled = users.iter().filter(|u| u.mfa_enabled).count();
    let percent = if users.is_empty() { 0 } else { (enabled as f64 * 100.0 / users.len() as f64).round() as u32 };
    (enabled, users.len() - enabled, percent)
}

/// A six-digit authenticator code from whatever was typed.
pub fn totp_input(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).take(6).collect()
}

/// An authenticator or backup code: digits, letters and readability dashes.
pub fn any_code_input(text: &str) -> String {
    text.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(9).collect()
}

/// The code to send, without dashes, when it has a valid length.
pub fn any_code(text: &str) -> Option<String> {
    let code: String = text.chars().filter(|c| *c != '-').collect();
    matches!(code.len(), 6 | 8).then_some(code)
}

/// "4:05", or "35s" under a minute.
pub fn cooldown_label(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    match secs / 60 {
        0 => format!("{secs}s"),
        m => format!("{m}:{:02}", secs % 60),
    }
}

/// An address shown partly, for a file that may be left lying around.
pub fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@').filter(|(l, d)| !l.is_empty() && !d.is_empty()) else {
        return "userema****@***.com".into();
    };
    let chars: Vec<char> = local.chars().collect();
    let keep = if chars.len() > 7 { 7 } else { chars.len().saturating_sub(4).max(1) };
    let tail: String = domain.chars().rev().take(3).collect::<Vec<_>>().into_iter().rev().collect();
    let masked_domain = if domain.chars().count() > 3 { format!("***{tail}") } else { "***.com".into() };
    format!("{}****@{masked_domain}", chars[..keep.min(chars.len())].iter().collect::<String>())
}

/// The backup-codes text file: (file name, contents). `generated` is the local
/// time shown in the file and `date` its YYYY-MM-DD for the name.
pub fn backup_codes_file(codes: &[String], email: &str, generated: &str, date: &str) -> (String, String) {
    let mut list = String::new();
    for (i, code) in codes.iter().enumerate() {
        let n = i + 1;
        list.push_str(&format!("[{}{n} ]  {code}\n", if n < 10 { " " } else { "" }));
        if n % 5 == 0 && n < codes.len() {
            list.push('\n');
        }
    }
    let content = format!(
        "Multi-Factor Authentication (MFA) Backup Codes\n\n\
         Application: TMA Cloud\nAccount: {}\nGenerated: {generated}\n\n---\n\n\
         IMPORTANT - READ CAREFULLY\n\n\
         - Each backup code can be used ONLY ONCE\n\
         - Store this file in a SECURE LOCATION\n\
         - Anyone with these codes can access your account\n\
         - If this file is lost or exposed, REGENERATE CODES IMMEDIATELY\n\n\
         Generating new backup codes will invalidate this entire list.\n\n---\n\n\
         BACKUP CODES\n\n{}\n\n---\n\n\
         HOW TO USE\n\nIf you cannot access your authenticator app:\n\n\
         1. Sign in with your email and password\n\
         2. When prompted for MFA, enter ONE unused backup code\n\
         3. The code will be invalid after successful use\n\n---\n\n\
         Need new backup codes?\nGo to: Settings > Security > Two-factor authentication\n",
        mask_email(email),
        list.trim_end()
    );
    (format!("mfa-backup-codes_TMA-Cloud_{date}.txt"), content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whole_numbers_respect_their_range() {
        assert_eq!(whole_number(" 30 ", (1, 365), "Days"), Ok(30));
        assert!(whole_number("0", (1, 365), "Days").is_err());
        assert!(whole_number("-1", (0, 10), "X").is_err());
        assert!(whole_number("1.5", (0, 10), "X").is_err());
        assert_eq!(whole_number("x", (1, 2), "Days"), Err("Days must be a whole number from 1 to 2".into()));
    }

    #[test]
    fn access_time_labels() {
        assert_eq!(access_time_label(false, 60), "Off");
        assert_eq!(access_time_label(true, 0), "Every read");
        assert_eq!(access_time_label(true, 60), "At most every 1 hour");
        assert_eq!(access_time_label(true, 120), "At most every 2 hours");
        assert_eq!(access_time_label(true, 45), "At most every 45 minutes");
    }

    #[test]
    fn sizes_round_trip_through_units() {
        assert_eq!(split_size(Some(10 * GB), Unit::Tb), ("10".into(), Unit::Gb));
        assert_eq!(split_size(Some(2 * TB), Unit::Tb), ("2".into(), Unit::Tb));
        assert_eq!(split_size(Some(2 * TB), Unit::Gb), ("2048".into(), Unit::Gb));
        assert_eq!(split_size(Some(512 * MB), Unit::Tb), ("512".into(), Unit::Mb));
        assert_eq!(split_size(None, Unit::Tb), (String::new(), Unit::Gb));
        assert_eq!(size_bytes("1.5", Unit::Gb), Some(GB + GB / 2));
        assert_eq!(size_bytes("0", Unit::Gb), None);
        assert_eq!(size_bytes("abc", Unit::Mb), None);
        assert_eq!(convert_size("1", Unit::Gb, Unit::Mb), "1024");
        assert_eq!(upload_limit_label(10 * GB), "10 GB");
        assert_eq!(upload_limit_label(512 * MB), "512 MB");
    }

    #[test]
    fn proxies_split_on_commas_and_lines() {
        assert_eq!(
            parse_proxies("10.0.0.1, 172.18.0.0/16\n proxy.local ,,"),
            ["10.0.0.1", "172.18.0.0/16", "proxy.local"]
        );
        assert_eq!(redirect_uri_for("https://cloud.example.com/"), "https://cloud.example.com/api/google/callback");
    }

    #[test]
    fn permission_summaries() {
        let all = tma_core::permissions::catalog();
        let keys = |n: usize| all.iter().take(n).map(|p| p.key.clone()).collect::<Vec<_>>();
        assert_eq!(permission_summary(&keys(all.len()), &all), "Full access");
        assert_eq!(permission_summary(&[], &all), "Browse only");
        assert_eq!(permission_summary(&keys(2), &all), "Download, Upload & create");
        assert_eq!(permission_summary(&keys(4), &all), "Download, Upload & create +2");
    }

    #[test]
    fn devices_and_platforms() {
        assert_eq!(device_label("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Windows");
        assert_eq!(device_label("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "Mobile");
        assert_eq!(device_label("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)"), "Mac");
        assert_eq!(device_label(""), "Unknown device");
        assert_eq!(platform_label(Some("win32")), "Windows");
        assert_eq!(platform_label(None), "Unknown");
    }

    fn user(id: &str, parent: Option<&str>, mfa: bool) -> AdminUser {
        AdminUser { id: id.into(), parent_user_id: parent.map(String::from), mfa_enabled: mfa, ..Default::default() }
    }

    #[test]
    fn sub_users_follow_their_owner() {
        let users = [
            user("s1", Some("a"), false),
            user("a", None, true),
            user("b", None, false),
            user("x", Some("gone"), true),
        ];
        assert_eq!(account_rows(&users), vec![(1, None), (0, Some(1)), (2, None), (3, None)]);
        assert_eq!(mfa_adoption(&users), (2, 2, 50));
        assert_eq!(mfa_adoption(&[]), (0, 0, 0));
    }

    #[test]
    fn versions_group_by_count() {
        let client = |v: &str| ActiveClient { app_version: v.into(), ..Default::default() };
        let groups = version_groups(&[client("4.0.0"), client("4.0.1"), client("4.0.1")]);
        assert_eq!(groups, vec![("4.0.1".into(), 2), ("4.0.0".into(), 1)]);
    }

    #[test]
    fn codes_are_filtered_as_typed() {
        assert_eq!(totp_input("12 34-56789"), "123456");
        assert_eq!(any_code_input("abcd-efgh!"), "ABCD-EFGH");
        assert_eq!(any_code("ABCD-EFGH"), Some("ABCDEFGH".into()));
        assert_eq!(any_code("123456"), Some("123456".into()));
        assert_eq!(any_code("1234567"), None);
        assert_eq!(cooldown_label(245_000), "4:05");
        assert_eq!(cooldown_label(35_000), "35s");
    }

    #[test]
    fn backup_codes_file_masks_the_account() {
        assert_eq!(mask_email("someone.long@example.com"), "someone****@***com");
        assert_eq!(mask_email("ab@x.io"), "a****@***.io");
        assert_eq!(mask_email("nobody"), "userema****@***.com");
        let codes: Vec<String> = (1..=10).map(|i| format!("CODE{i:04}")).collect();
        let (name, content) = backup_codes_file(&codes, "me@example.com", "October 16, 2026", "2026-10-16");
        assert_eq!(name, "mfa-backup-codes_TMA-Cloud_2026-10-16.txt");
        assert!(content.contains("[ 1 ]  CODE0001\n"));
        assert!(content.contains("[ 5 ]  CODE0005\n\n[ 6 ]"));
        assert!(content.contains("[10 ]  CODE0010\n\n---"));
        assert!(!content.contains("me@example.com"));
    }
}
