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
