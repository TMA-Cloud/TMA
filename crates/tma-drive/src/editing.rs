//! Which documents an app has open for editing, read from the owner files
//! editors keep beside them while a document is open: Office's `~$` files and
//! LibreOffice's `.~lock.NAME#`. Both go away when the document closes.

use crate::sync_plan;

enum Owner {
    /// LibreOffice names the whole document.
    Exact(String),
    /// Office prefixes `~$`, dropping the first one or two characters of a long name.
    Office(String),
}

fn owner(name: &str) -> Option<Owner> {
    let lower = name.to_lowercase();
    if let Some(doc) = lower.strip_prefix(".~lock.").and_then(|r| r.strip_suffix('#')) {
        return Some(Owner::Exact(doc.to_string()));
    }
    lower.strip_prefix("~$").filter(|r| r.contains('.')).map(|r| Owner::Office(r.to_string()))
}

impl Owner {
    fn marks(&self, doc: &str) -> bool {
        let doc = doc.to_lowercase();
        match self {
            Owner::Exact(name) => doc == *name,
            Owner::Office(rest) => {
                doc.ends_with(rest.as_str()) && doc.chars().count().saturating_sub(rest.chars().count()) <= 2
            }
        }
    }
}

/// Office and LibreOffice formats: those programs leave an owner file per open
/// document, which says more than whether the program is running.
pub fn has_owner_files(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "doc", "docx", "docm", "dot", "dotx", "dotm", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "xltm", "ppt",
        "pptx", "pptm", "pps", "ppsx", "pot", "potx", "odt", "ods", "odp", "odg", "ott", "ots", "otp",
    ];
    EXTS.contains(&tma_core::names::extension_of(name).as_str())
}

/// Whether a window title names the file `name`: in full, or by its name without
/// the extension as a whole word, as some programs show it.
pub fn window_shows(title: &str, name: &str) -> bool {
    let (title, name) = (title.to_lowercase(), name.to_lowercase());
    if title.contains(&name) {
        return true;
    }
    let stem = name.rsplit_once('.').map_or(name.as_str(), |(stem, _)| stem);
    // A short stem ("a", "doc") turns up in unrelated titles.
    if stem.chars().count() < 4 {
        return false;
    }
    title.match_indices(stem).any(|(at, _)| {
        let before = title[..at].chars().next_back();
        let after = title[at + stem.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

/// The names in a folder that an owner file in the same folder marks as open.
pub fn edited(names: &[String]) -> Vec<String> {
    let owners: Vec<Owner> = names.iter().filter_map(|n| owner(n)).collect();
    if owners.is_empty() {
        return Vec::new();
    }
    names.iter().filter(|n| !sync_plan::is_local_only(n) && owners.iter().any(|o| o.marks(n))).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(names: &[&str]) -> Vec<String> {
        edited(&names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn office_owner_files_mark_their_document() {
        assert_eq!(open(&["Budget.xlsx", "~$Budget.xlsx", "Other.xlsx"]), ["Budget.xlsx"]);
        // Word drops the first two characters of a long name, one of a seven-letter one.
        assert_eq!(open(&["Quarterly Report.docx", "~$arterly Report.docx"]), ["Quarterly Report.docx"]);
        assert_eq!(open(&["Minutes.docx", "~$inutes.docx"]), ["Minutes.docx"]);
        assert_eq!(open(&["Notes.DOCX", "~$notes.docx"]), ["Notes.DOCX"]);
    }

    #[test]
    fn window_titles_name_the_file_in_full_or_by_stem() {
        assert!(window_shows("Checklist.txt - Notepad", "Checklist.txt"));
        assert!(window_shows("*checklist.txt - Notepad", "Checklist.txt"));
        assert!(window_shows("Moodboard.jpg", "Moodboard.jpg"));
        assert!(window_shows("Quarterly Report - Paint", "Quarterly Report.png"));
        assert!(!window_shows("Quarterly Reports - Paint", "Quarterly Report.png"), "a longer word is another name");
        assert!(!window_shows("Notepad", "a.txt"));
        assert!(!window_shows("Docs - Google Chrome", "doc.txt"), "short stems never match alone");
    }

    #[test]
    fn libreoffice_lock_files_mark_their_document() {
        assert_eq!(open(&["Plan.odt", ".~lock.Plan.odt#", "Plan2.odt"]), ["Plan.odt"]);
    }

    #[test]
    fn nothing_is_open_without_an_owner_file() {
        assert!(open(&["Budget.xlsx", "~WRL0001.tmp", "Notes.txt"]).is_empty());
        // A name that only shares an ending is a different document.
        assert!(open(&["My Budget.xlsx", "~$Budget.xlsx"]).is_empty());
    }
}
