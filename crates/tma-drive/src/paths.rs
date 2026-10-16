//! Drive paths: backslash-separated from the root ("\\Photos\\a.jpg"), compared
//! without regard to case like Windows does.

pub const ROOT: &str = "\\";

pub fn key(path: &str) -> String {
    path.to_lowercase()
}

pub fn parent(path: &str) -> Option<String> {
    if path == ROOT {
        return None;
    }
    match path.rfind('\\') {
        Some(0) | None => Some(ROOT.to_string()),
        Some(i) => Some(path[..i].to_string()),
    }
}

pub fn leaf(path: &str) -> &str {
    if path == ROOT {
        return "";
    }
    path.rfind('\\').map(|i| &path[i + 1..]).unwrap_or(path)
}

pub fn join(dir: &str, name: &str) -> String {
    if dir == ROOT { format!("\\{name}") } else { format!("{dir}\\{name}") }
}

/// Normalize "/a/b", "a\\b" or "\\a\\b\\" to "\\a\\b".
pub fn normalize(path: &str) -> String {
    let parts: Vec<&str> = path.split(['\\', '/']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() { ROOT.to_string() } else { format!("\\{}", parts.join("\\")) }
}

pub fn is_at_or_under(path: &str, root: &str) -> bool {
    let (path, root) = (key(path), key(root));
    path == root || path.starts_with(&if root == ROOT { root.clone() } else { format!("{root}\\") })
}

/// A name the drive accepts: no separators or reserved characters, no trailing dot or space.
pub fn is_safe_name(name: &str) -> bool {
    if name.is_empty() || name.chars().count() > 255 || name == "." || name == ".." || name.ends_with(['.', ' ']) {
        return false;
    }
    !name.chars().any(|c| {
        (c as u32) < 0x20 || c == '\u{7f}' || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(parent("\\a\\b").as_deref(), Some("\\a"));
        assert_eq!(parent("\\a").as_deref(), Some("\\"));
        assert_eq!(parent("\\"), None);
        assert_eq!(leaf("\\a\\b.txt"), "b.txt");
        assert_eq!(join("\\", "x"), "\\x");
        assert_eq!(normalize("/a//b/"), "\\a\\b");
        assert!(is_at_or_under("\\A\\b", "\\a"));
        assert!(!is_at_or_under("\\ab", "\\a"));
        assert!(!is_safe_name("a:b") && !is_safe_name("a.") && is_safe_name("report.docx"));
    }
}
