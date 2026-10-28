//! File and folder names. Names are stored as the user's OS wrote them; only
//! what no filesystem can hold in one component is refused. Windows-only limits
//! are handled where a name meets Windows (ZIP entries, the Cloud Drive).

/// Longest name one item may have, in UTF-16 code units like the old API.
pub const MAX_ITEM_NAME_LENGTH: usize = 255;

/// Whether `name` can be stored as one file or folder name.
pub fn is_valid_item_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() || name.encode_utf16().count() > MAX_ITEM_NAME_LENGTH {
        return false;
    }
    if trimmed == "." || trimmed == ".." {
        return false;
    }
    // "/" and "\" are separators somewhere, and control characters break headers and logs.
    !name.chars().any(|c| c == '/' || c == '\\' || (c as u32) < 0x20 || c == '\u{7f}')
}

/// One path segment every common OS can extract, as browsers do for downloads.
pub fn portable_name(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = mapped.trim_end_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." { "_".to_string() } else { trimmed.to_string() }
}

/// Lowercase extension without its dot; a leading dot is a hidden file's name.
pub fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Node's `path.extname` for one name: the last dot and what follows, unless
/// that dot leads the name, so stored names keep the split they always had.
pub fn extname(name: &str) -> &str {
    let bytes = name.as_bytes();
    let mut start_dot: Option<usize> = None;
    // 0: nothing seen left of the last dot, -1: a non-dot, 1: another dot.
    let mut pre_dot_state = 0i8;
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'.' {
            if start_dot.is_none() {
                start_dot = Some(i);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    let end = bytes.len();
    match start_dot {
        None => "",
        Some(_) if pre_dot_state == 0 => "",
        Some(dot) if pre_dot_state == 1 && dot + 1 == end && dot == 1 => "",
        Some(dot) => &name[dot..],
    }
}

/// `name` split into stem and extension the way `path.extname` does.
pub fn split_ext(name: &str) -> (&str, &str) {
    let ext = extname(name);
    (&name[..name.len() - ext.len()], ext)
}

/// "Report (2).pdf" for a clash, keeping the extension of files.
pub fn numbered_name(name: &str, counter: u32, is_file: bool) -> String {
    if is_file {
        let (stem, ext) = split_ext(name);
        format!("{stem} ({counter}){ext}")
    } else {
        format!("{name} ({counter})")
    }
}

/// Whether `name` is already taken among `names`, ignoring case as Windows and macOS do.
pub fn is_taken<'a>(name: &str, names: impl IntoIterator<Item = &'a str>) -> bool {
    let wanted = name.trim().to_lowercase();
    names.into_iter().any(|n| n.trim().to_lowercase() == wanted)
}

/// `base`, or the first of "base (2)", "base (3)"… that none of `names` takes.
pub fn first_free<'a>(base: &str, names: impl IntoIterator<Item = &'a str> + Clone, is_file: bool) -> String {
    if !is_taken(base, names.clone()) {
        return base.to_string();
    }
    (2..)
        .map(|n| numbered_name(base, n, is_file))
        .find(|candidate| !is_taken(candidate, names.clone()))
        .unwrap_or_else(|| base.to_string())
}

/// What is wrong with a name typed for a new or renamed item, if anything.
pub fn name_problem<'a>(name: &str, taken: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    if name.trim().is_empty() {
        return None;
    }
    if !is_valid_item_name(name) {
        return Some("Names can be up to 255 characters and cannot contain / or \\");
    }
    is_taken(name, taken).then_some("An item with this name is already here")
}

/// The name to show when extensions are hidden; dotfiles keep their full name.
pub fn display_name(name: &str, is_file: bool, hide_extensions: bool) -> &str {
    if !hide_extensions || !is_file {
        return name;
    }
    let (stem, ext) = split_ext(name);
    if stem.chars().any(|c| c != '.') && !ext.is_empty() { stem } else { name }
}

/// The extension hiding strips, re-attached after a rename of the visible stem.
pub fn full_name_for_rename(edited: &str, original: &str) -> String {
    let (stem, ext) = split_ext(original);
    let keep = if stem.chars().any(|c| c != '.') { ext } else { "" };
    format!("{}{}", edited.trim(), keep)
}

const WINDOWS_OFFSET: u32 = 0xF000;

fn is_windows_reserved(c: char) -> bool {
    (c as u32) < 0x20 || matches!(c, '"' | '*' | ':' | '<' | '>' | '?' | '|' | '\\')
}

/// The name Windows sees for a stored name. A reserved character, or a trailing
/// dot or space, maps into the private-use area (as Cygwin and WSL do), so the
/// round trip through [`windows_to_server`] is exact.
pub fn server_to_windows(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut end = chars.len();
    while end > 0 && matches!(chars[end - 1], '.' | ' ') {
        end -= 1;
    }
    chars
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            if !is_windows_reserved(c) && i < end { c } else { char::from_u32(WINDOWS_OFFSET | c as u32).unwrap_or(c) }
        })
        .collect()
}

/// The stored name for a name Windows passed in.
pub fn windows_to_server(name: &str) -> String {
    name.chars()
        .map(|c| {
            let code = c as u32;
            let plain = char::from_u32(code & 0x7F).unwrap_or(c);
            let encoded = (code & 0xFF80) == WINDOWS_OFFSET
                && plain != '\0'
                && (is_windows_reserved(plain) || plain == '.' || plain == ' ');
            if encoded { plain } else { c }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn free_names_count_up_past_clashes() {
        let names = ["New folder", "new folder (2)", "Other"];
        assert_eq!(super::first_free("New folder", names, false), "New folder (3)");
        assert_eq!(super::first_free("Fresh", names, false), "Fresh");
        assert_eq!(super::first_free("a.txt", ["A.TXT"], true), "a (2).txt");
    }

    #[test]
    fn typed_names_are_checked() {
        assert_eq!(super::name_problem("", ["x"]), None);
        assert_eq!(super::name_problem("Other ", ["other"]), Some("An item with this name is already here"));
        assert!(super::name_problem("a/b", []).is_some());
        assert_eq!(super::name_problem("Fine", ["Other"]), None);
    }

    use super::*;

    #[test]
    fn valid_names() {
        assert!(is_valid_item_name("Report: final?.pdf"));
        assert!(!is_valid_item_name("a/b"));
        assert!(!is_valid_item_name(".."));
        assert!(!is_valid_item_name("   "));
        assert!(!is_valid_item_name("tab\there"));
    }

    #[test]
    fn extname_matches_node() {
        assert_eq!(extname("a.tar.gz"), ".gz");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("noext"), "");
        assert_eq!(extname("trailing."), ".");
        assert_eq!(extname(".."), "");
        assert_eq!(extname(".index.md"), ".md");
        assert_eq!(numbered_name("photo.jpg", 2, true), "photo (2).jpg");
        assert_eq!(numbered_name("Docs", 1, false), "Docs (1)");
    }

    /// Whether a name is safe as one Windows path component.
    fn is_safe_windows_name(name: &str) -> bool {
        if name.is_empty() || name.encode_utf16().count() > 255 || name == "." || name == ".." {
            return false;
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return false;
        }
        !name.chars().any(|c| {
            (c as u32) < 0x20 || c == '\u{7f}' || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    }

    #[test]
    fn windows_round_trip() {
        for name in ["a:b?.txt", "dots...", "plain.txt", "tail ", "q\"x"] {
            let win = server_to_windows(name);
            assert!(is_safe_windows_name(&win) || name == "plain.txt");
            assert_eq!(windows_to_server(&win), name);
        }
    }

    #[test]
    fn display_names() {
        assert_eq!(display_name("report.pdf", true, true), "report");
        assert_eq!(display_name(".txt", true, true), ".txt");
        assert_eq!(full_name_for_rename("new ", "report.pdf"), "new.pdf");
        assert_eq!(portable_name("a:b?. "), "a_b_");
    }
}
