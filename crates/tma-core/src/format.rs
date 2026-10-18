//! Human-readable sizes and dates, shared by every screen and the share pages.

use chrono::{DateTime, Datelike, Local, Utc};

const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];

/// Size with one decimal ("1.5 MB"), the format listings use.
pub fn file_size(bytes: i64) -> String {
    if bytes < 0 {
        return String::new();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let text = format!("{value:.1}");
    let text = text.strip_suffix(".0").unwrap_or(&text);
    format!("{text} {}", UNITS[unit])
}

/// Size with up to two decimals ("1.25 GB"), the format storage figures use.
pub fn storage_size(bytes: i64) -> String {
    if bytes < 0 {
        return "—".into();
    }
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 1;
    while value >= 1024.0 && unit < 4 {
        value /= 1024.0;
        unit += 1;
    }
    let text = format!("{value:.2}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    format!("{text} {}", UNITS[unit])
}

/// Compact size for the public share page: "1.4 MB", "12 KB", nothing for zero.
pub fn share_size(bytes: i64) -> String {
    if bytes <= 0 {
        return String::new();
    }
    let n = bytes as f64;
    let i = ((n.ln() / 1024f64.ln()).floor() as usize).min(4);
    let value = n / 1024f64.powi(i as i32);
    if i == 0 {
        format!("{value} {}", UNITS[0])
    } else if value >= 10.0 {
        format!("{value:.0} {}", UNITS[i])
    } else {
        format!("{value:.1} {}", UNITS[i])
    }
}

/// "2:30 PM" today, "Yesterday", "3 days ago" within a week, else "Jan 5, 2026".
pub fn relative_date(date: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let local = date.with_timezone(&Local);
    let local_now = now.with_timezone(&Local);
    let day_diff = local_now.date_naive().signed_duration_since(local.date_naive()).num_days();
    if day_diff == 0 {
        return local.format("%-I:%M %p").to_string();
    }
    if day_diff == 1 {
        return "Yesterday".into();
    }
    let days = (now - date).num_days();
    if (0..7).contains(&days) {
        return if days <= 1 { "1 day ago".into() } else { format!("{days} days ago") };
    }
    if local.year() == local_now.year() {
        return local.format("%b %-d").to_string();
    }
    local.format("%b %-d, %Y").to_string()
}

/// The calendar day alone: "Jan 5, 2026".
pub fn day(date: DateTime<Utc>) -> String {
    date.with_timezone(&Local).format("%b %-d, %Y").to_string()
}

/// Full timestamp for Get Info: "Jan 5, 2026 at 2:30 PM".
pub fn full_date(date: DateTime<Utc>) -> String {
    date.with_timezone(&Local).format("%b %-d, %Y at %-I:%M %p").to_string()
}

/// Compact share countdown for an icon badge: "7d", "5h", "12m", "∞".
pub fn share_badge(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    let Some(at) = expires_at else { return "∞".into() };
    let ms = (at - now).num_milliseconds();
    if ms <= 0 {
        return "Expired".into();
    }
    let minutes = (ms + 59_999) / 60_000;
    if minutes >= 1440 {
        format!("{}d", (minutes + 1439) / 1440)
    } else if minutes >= 60 {
        format!("{}h", (minutes + 59) / 60)
    } else {
        format!("{minutes}m")
    }
}

/// Long share countdown for Get Info: "6 days, 3 hours remaining".
pub fn share_remaining(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> String {
    let Some(at) = expires_at else { return "Never expires".into() };
    let ms = (at - now).num_milliseconds();
    if ms <= 0 {
        return "Expired".into();
    }
    let total = (ms + 59_999) / 60_000;
    let (days, hours, minutes) = (total / 1440, (total % 1440) / 60, total % 60);
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(plural(days, "day"));
    }
    if hours > 0 {
        parts.push(plural(hours, "hour"));
    }
    if days == 0 && minutes > 0 {
        parts.push(plural(minutes, "minute"));
    }
    format!("{} remaining", parts.join(", "))
}

/// "1 file", "3 folders": a count with its noun in the right number.
pub fn count(n: usize, singular: &str, plural: &str) -> String {
    format!("{n} {}", if n == 1 { singular } else { plural })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        assert_eq!(file_size(0), "0 B");
        assert_eq!(file_size(1536), "1.5 KB");
        assert_eq!(file_size(1024 * 1024), "1 MB");
        assert_eq!(storage_size(1024 * 1024 * 1024 + 1024 * 1024 * 256), "1.25 GB");
        assert_eq!(share_size(1_468_006), "1.4 MB");
        assert_eq!(share_size(0), "");
    }

    #[test]
    fn countdowns() {
        let now = Utc::now();
        assert_eq!(share_badge(None, now), "∞");
        assert_eq!(share_badge(Some(now + chrono::Duration::days(7)), now), "7d");
        assert_eq!(share_badge(Some(now - chrono::Duration::days(1)), now), "Expired");
        assert_eq!(share_remaining(Some(now + chrono::Duration::minutes(90)), now), "1 hour, 30 minutes remaining");
    }
}
