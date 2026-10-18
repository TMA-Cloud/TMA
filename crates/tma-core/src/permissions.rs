//! Sub-user permissions: an explicit set of capabilities rather than a coarse
//! role. Browsing is not a permission; every capability beyond looking is
//! opt-in. The keys are mirrored by a CHECK constraint (migration 059).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "files.download")]
    Download,
    #[serde(rename = "files.upload")]
    Upload,
    #[serde(rename = "files.edit")]
    Edit,
    #[serde(rename = "files.delete")]
    Delete,
    #[serde(rename = "files.restore")]
    Restore,
    #[serde(rename = "files.purge")]
    Purge,
    #[serde(rename = "files.share")]
    Share,
}

/// One row of the catalog served to clients.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionInfo {
    pub key: String,
    pub label: String,
    pub description: String,
}

/// Least to most destructive, so the checklist reads like Windows' permission list.
pub const ALL: [Permission; 7] = [
    Permission::Download,
    Permission::Upload,
    Permission::Edit,
    Permission::Share,
    Permission::Delete,
    Permission::Restore,
    Permission::Purge,
];

impl Permission {
    pub fn key(self) -> &'static str {
        match self {
            Self::Download => "files.download",
            Self::Upload => "files.upload",
            Self::Edit => "files.edit",
            Self::Delete => "files.delete",
            Self::Restore => "files.restore",
            Self::Purge => "files.purge",
            Self::Share => "files.share",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        ALL.into_iter().find(|p| p.key() == key)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Download => "Download",
            Self::Upload => "Upload & create",
            Self::Edit => "Modify",
            Self::Share => "Share",
            Self::Delete => "Move to trash",
            Self::Restore => "Restore from trash",
            Self::Purge => "Delete permanently",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Self::Download => "Download files and folders, and open them in the document viewer",
            Self::Upload => "Upload files, create folders, and copy existing items",
            Self::Edit => "Rename, move, star, and edit document contents",
            Self::Share => "Create and revoke public share links",
            Self::Delete => "Send files and folders to the trash",
            Self::Restore => "Put items in the trash back where they were",
            Self::Purge => "Delete items in the trash for good, and empty the trash",
        }
    }
}

/// The catalog in display order.
pub fn catalog() -> Vec<PermissionInfo> {
    ALL.iter()
        .map(|p| PermissionInfo { key: p.key().into(), label: p.label().into(), description: p.description().into() })
        .collect()
}

/// Every key, in catalog order.
pub fn all_keys() -> Vec<String> {
    ALL.iter().map(|p| p.key().to_string()).collect()
}

/// Drop unknown keys and duplicates, returning catalog order so rows compare.
pub fn normalize(keys: &[String]) -> Vec<String> {
    ALL.iter().filter(|p| keys.iter().any(|k| k == p.key())).map(|p| p.key().to_string()).collect()
}

/// Whether every key is known.
pub fn all_valid(keys: &[String]) -> bool {
    keys.iter().all(|k| Permission::from_key(k).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_in_catalog_order() {
        let input = vec!["files.purge".to_string(), "bogus".into(), "files.download".into(), "files.purge".into()];
        assert_eq!(normalize(&input), vec!["files.download", "files.purge"]);
        assert!(!all_valid(&input));
    }
}
