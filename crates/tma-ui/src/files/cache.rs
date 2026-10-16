//! Listings already seen, so revisiting a folder shows it at once while the
//! fresh listing loads, and Back lands where the list was scrolled to.

use std::collections::HashMap;

use tma_core::api::{FileItem, SortBy, SortOrder};

use super::Place;

/// Enough for a session's worth of folders; beyond it the oldest go first.
const MAX_ENTRIES: usize = 64;

#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub items: Vec<FileItem>,
    pub cursor: Option<String>,
    pub scroll: f32,
    used: u64,
}

#[derive(Debug, Default)]
pub struct ListingCache {
    entries: HashMap<String, Entry>,
    clock: u64,
}

/// One listing: the place, the folder within it, and its order.
pub fn key(place: &Place, path: &[(String, String)], sort: SortBy, order: SortOrder) -> String {
    let ids: Vec<&str> = path.iter().map(|(id, _)| id.as_str()).collect();
    format!("{place:?}/{}/{sort:?}/{order:?}", ids.join("/"))
}

impl ListingCache {
    pub fn get(&mut self, key: &str) -> Option<Entry> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|e| {
            e.used = clock;
            e.clone()
        })
    }

    /// Store a fresh listing, keeping the scroll position already remembered for it.
    pub fn put(&mut self, key: String, items: Vec<FileItem>, cursor: Option<String>) {
        self.clock += 1;
        let scroll = self.entries.get(&key).map(|e| e.scroll).unwrap_or(0.0);
        self.entries.insert(key, Entry { items, cursor, scroll, used: self.clock });
        if self.entries.len() > MAX_ENTRIES
            && let Some(oldest) = self.entries.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest);
        }
    }

    pub fn remember_scroll(&mut self, key: &str, scroll: f32) {
        if let Some(entry) = self.entries.get_mut(key) {
            entry.scroll = scroll;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(ids: &[&str]) -> Vec<(String, String)> {
        ids.iter().map(|id| (id.to_string(), format!("name {id}"))).collect()
    }

    #[test]
    fn keys_tell_listings_apart() {
        let a = key(&Place::Folder, &path(&["1"]), SortBy::Name, SortOrder::Asc);
        assert_eq!(a, key(&Place::Folder, &path(&["1"]), SortBy::Name, SortOrder::Asc));
        assert_ne!(a, key(&Place::Folder, &path(&["2"]), SortBy::Name, SortOrder::Asc));
        assert_ne!(a, key(&Place::Folder, &path(&["1"]), SortBy::Size, SortOrder::Asc));
        assert_ne!(a, key(&Place::Starred, &path(&["1"]), SortBy::Name, SortOrder::Asc));
    }

    #[test]
    fn keeps_scroll_across_refreshes_and_evicts_the_oldest() {
        let mut cache = ListingCache::default();
        cache.put("a".into(), Vec::new(), None);
        cache.remember_scroll("a", 120.0);
        cache.put("a".into(), Vec::new(), Some("next".into()));
        let entry = cache.get("a");
        assert_eq!(entry.as_ref().map(|e| e.scroll), Some(120.0));
        assert_eq!(entry.and_then(|e| e.cursor).as_deref(), Some("next"));
        for i in 0..MAX_ENTRIES {
            cache.put(format!("k{i}"), Vec::new(), None);
        }
        assert!(cache.get("a").is_none(), "the least recently used entry goes first");
        assert!(cache.get(&format!("k{}", MAX_ENTRIES - 1)).is_some());
    }
}
