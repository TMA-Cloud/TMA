//! The file browser: one listing (a folder, Starred, Shared, Trash or search
//! results), its selection and clipboard, paged in from the server.

mod actions;
mod cache;
mod conflicts;
mod download;
mod grid;
mod jobs;
mod keys;
mod marquee;
mod menu;
mod open;
pub mod opening;
mod paste;
mod sharing;
mod thumbs;
mod toolbar;
mod view;

pub(crate) use actions::items_label;
pub use actions::{Action, download, run as run_action, stage_files, upload_files};
pub(crate) use jobs::{move_to, settle_job, trash};
pub use view::show;

use std::collections::BTreeSet;

use tma_client::{Client, ListQuery, View};
use tma_core::api::{FileItem, SortBy, SortOrder};

use crate::app::{App, Prefs};
use crate::tasks::Tasks;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    Folder,
    Starred,
    Shared,
    Trash,
    Search(String),
}

/// Items cut or copied for pasting elsewhere.
#[derive(Debug, Clone)]
pub struct Clip {
    pub ids: Vec<String>,
    pub cut: bool,
    /// The system clipboard's sequence number at the time, to tell which copy is newer.
    pub seq: u64,
}

pub struct Browser {
    pub place: Place,
    /// Folder crumbs from the root, `(id, name)`; empty at the root.
    pub path: Vec<(String, String)>,
    pub items: Vec<FileItem>,
    pub cursor: Option<String>,
    pub loading: bool,
    pub loading_more: bool,
    pub loaded: bool,
    pub error: Option<String>,
    pub selected: BTreeSet<String>,
    pub anchor: Option<String>,
    pub clip: Option<Clip>,
    /// Another app put files on the system clipboard (checked each frame).
    pub system_clip: bool,
    /// Folder the pointer drags items onto.
    pub drop_target: Option<String>,
    /// Places visited before and after this one, for Back and Forward.
    pub back: Vec<Location>,
    pub forward: Vec<Location>,
    /// Letters typed to select an item by name, and when the last one came.
    pub typed: (String, f64),
    /// A row the keyboard moved to, scrolled into view on the next frame.
    pub scroll_to: Option<usize>,
    /// A rubber-band selection in progress.
    pub marquee: Option<marquee::Drag>,
    pub thumbs: thumbs::Thumbs,
    /// Uploads waiting for a Replace or Keep both answer.
    pub conflicts: Option<conflicts::Pending>,
    /// Folders seen shared in a listing, so items inside one can join its share.
    pub shared_folders: std::collections::HashSet<String>,
    /// On a touch screen, taps select instead of opening (the web app's multi-select mode).
    pub select_mode: bool,
    /// Listings seen this session, shown at once when revisited.
    cache: cache::ListingCache,
    /// The list's scroll offset, read back each frame.
    pub scroll: f32,
    /// An offset to scroll to on the next frame (top of a new place, or where Back left it).
    pub scroll_set: Option<f32>,
    /// The folder just left, selected and scrolled to once a listing shows it.
    reveal: Option<String>,
    request: u64,
}

/// Where the browser is: the place and its folder crumbs.
pub type Location = (Place, Vec<(String, String)>);

const HISTORY: usize = 50;

impl Default for Browser {
    fn default() -> Self {
        Self {
            place: Place::Folder,
            path: Vec::new(),
            items: Vec::new(),
            cursor: None,
            loading: false,
            loading_more: false,
            loaded: false,
            error: None,
            selected: BTreeSet::new(),
            anchor: None,
            clip: None,
            system_clip: false,
            drop_target: None,
            back: Vec::new(),
            forward: Vec::new(),
            typed: (String::new(), 0.0),
            scroll_to: None,
            marquee: None,
            thumbs: thumbs::Thumbs::default(),
            conflicts: None,
            select_mode: false,
            shared_folders: std::collections::HashSet::new(),
            cache: cache::ListingCache::default(),
            scroll: 0.0,
            scroll_set: None,
            reveal: None,
            request: 0,
        }
    }
}

impl Browser {
    pub fn folder_id(&self) -> Option<String> {
        if self.place == Place::Folder { self.path.last().map(|(id, _)| id.clone()) } else { None }
    }

    fn view(&self) -> Option<View> {
        Some(match &self.place {
            Place::Folder => View::Folder(self.folder_id()),
            Place::Starred => View::Starred,
            Place::Shared => View::Shared,
            Place::Trash => View::Trash,
            Place::Search(_) => return None,
        })
    }

    fn query(&self, prefs: &Prefs, cursor: Option<String>) -> ListQuery {
        let (sort, order) = if self.place == Place::Trash && prefs.sort == SortBy::Name {
            (SortBy::DeletedAt, SortOrder::Desc)
        } else {
            (prefs.sort, prefs.order)
        };
        ListQuery { sort: Some(sort), order: Some(order), cursor, limit: Some(200) }
    }

    /// Switch to a place and load it from the start.
    pub fn open(
        &mut self,
        place: Place,
        path: Vec<(String, String)>,
        tasks: &Tasks,
        client: &Client,
        generation: u64,
        prefs: &Prefs,
    ) {
        let here = (self.place.clone(), self.path.clone());
        if here != (place.clone(), path.clone()) {
            self.back.push(here);
            if self.back.len() > HISTORY {
                self.back.remove(0);
            }
            self.forward.clear();
        }
        // Going up to a folder on the current path returns to where it was scrolled.
        let up = place == Place::Folder
            && self.place == Place::Folder
            && path.len() < self.path.len()
            && self.path.starts_with(&path);
        self.show(place, path, up, tasks, client, generation, prefs);
    }

    /// Step through history: `true` goes back, `false` forward.
    pub fn go(&mut self, back: bool, tasks: &Tasks, client: &Client, generation: u64, prefs: &Prefs) {
        let (from, to) = if back { (&mut self.back, &mut self.forward) } else { (&mut self.forward, &mut self.back) };
        let Some((place, path)) = from.pop() else { return };
        to.push((self.place.clone(), self.path.clone()));
        self.show(place, path, true, tasks, client, generation, prefs);
    }

    /// Switch to a place: its last listing at once if seen before, then a fresh one.
    #[expect(
        clippy::too_many_arguments,
        reason = "the place, its path and the session it loads in, all needed together"
    )]
    fn show(
        &mut self,
        place: Place,
        path: Vec<(String, String)>,
        restore_scroll: bool,
        tasks: &Tasks,
        client: &Client,
        generation: u64,
        prefs: &Prefs,
    ) {
        let leaving = self.cache_key(prefs);
        self.cache.remember_scroll(&leaving, self.scroll);
        self.reveal = left_child(&self.place, &self.path, &place, &path);
        self.place = place;
        self.path = path;
        self.scroll_to = None;
        self.selected.clear();
        self.anchor = None;
        self.select_mode = false;
        match self.cache.get(&self.cache_key(prefs)) {
            Some(seen) => {
                self.items = seen.items;
                self.cursor = seen.cursor;
                self.loaded = true;
                self.scroll_set = Some(if restore_scroll { seen.scroll } else { 0.0 });
                self.reveal_left_child(restore_scroll);
            }
            None => {
                self.items.clear();
                self.cursor = None;
                self.loaded = false;
                self.scroll_set = Some(0.0);
            }
        }
        self.load(tasks, client, generation, prefs);
    }

    /// Select the folder just left, as file managers do on the way up; scroll to
    /// it unless a remembered offset already puts the view where it was.
    fn reveal_left_child(&mut self, scrolled: bool) {
        let Some(id) = self.reveal.clone() else { return };
        let Some(index) = self.items.iter().position(|i| i.id == id) else { return };
        self.reveal = None;
        self.select_only(&id);
        if !scrolled {
            self.scroll_to = Some(index);
        }
    }

    fn cache_key(&self, prefs: &Prefs) -> String {
        let query = self.query(prefs, None);
        cache::key(&self.place, &self.path, query.sort.unwrap_or_default(), query.order.unwrap_or_default())
    }

    pub fn enter_folder(
        &mut self,
        id: &str,
        name: &str,
        tasks: &Tasks,
        client: &Client,
        generation: u64,
        prefs: &Prefs,
    ) {
        let mut path = if self.place == Place::Folder { self.path.clone() } else { Vec::new() };
        path.push((id.to_string(), name.to_string()));
        self.open(Place::Folder, path, tasks, client, generation, prefs);
    }

    /// Fetch the first page.
    pub fn load(&mut self, tasks: &Tasks, client: &Client, generation: u64, prefs: &Prefs) {
        self.request += 1;
        self.loading = true;
        self.error = None;
        let request = self.request;
        let client = client.clone();
        match (self.view(), &self.place) {
            (Some(view), _) => {
                let query = self.query(prefs, None);
                tasks.run(async move { client.list(&view, &query).await }, move |app: &mut App, result| {
                    apply_page(app, generation, request, result, false)
                });
            }
            (None, Place::Search(q)) => {
                let q = q.clone();
                tasks.run(
                    async move {
                        client.search(&q, 200).await.map(|files| tma_client::Listing { files, next_cursor: None })
                    },
                    move |app: &mut App, result| apply_page(app, generation, request, result, false),
                );
            }
            (None, _) => {}
        }
    }

    /// Reload after a change elsewhere, keeping the selection.
    pub fn reload(&mut self, tasks: &Tasks, client: &Client, generation: u64, prefs: &Prefs) {
        self.load(tasks, client, generation, prefs);
    }

    pub fn load_more(&mut self, tasks: &Tasks, client: &Client, generation: u64, prefs: &Prefs) {
        let (Some(view), Some(cursor)) = (self.view(), self.cursor.clone()) else { return };
        if self.loading_more || self.loading {
            return;
        }
        self.loading_more = true;
        let request = self.request;
        let query = self.query(prefs, Some(cursor));
        let client = client.clone();
        tasks.run(async move { client.list(&view, &query).await }, move |app: &mut App, result| {
            apply_page(app, generation, request, result, true)
        });
    }

    pub fn selected_items(&self) -> Vec<FileItem> {
        self.items.iter().filter(|i| self.selected.contains(&i.id)).cloned().collect()
    }

    pub fn select_only(&mut self, id: &str) {
        self.selected.clear();
        self.selected.insert(id.to_string());
        self.anchor = Some(id.to_string());
    }

    /// Whether the open folder is shared (its items can join that share).
    pub fn in_shared_folder(&self) -> bool {
        self.folder_id().is_some_and(|id| self.shared_folders.contains(&id))
    }

    pub fn title(&self) -> String {
        match &self.place {
            Place::Folder => self.path.last().map(|(_, n)| n.clone()).unwrap_or_else(|| "My Files".into()),
            Place::Starred => "Starred".into(),
            Place::Shared => "Shared".into(),
            Place::Trash => "Trash".into(),
            Place::Search(q) => format!("Results for “{q}”"),
        }
    }
}

/// The folder of `from` that leads down from `to`, when `to` is one of its ancestors.
fn left_child(
    from_place: &Place,
    from: &[(String, String)],
    to_place: &Place,
    to: &[(String, String)],
) -> Option<String> {
    let up = *from_place == Place::Folder && *to_place == Place::Folder && from.starts_with(to);
    if up { from.get(to.len()).map(|(id, _)| id.clone()) } else { None }
}

/// Who has a file open in a desktop app, while their edit lock lasts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Editor<'a> {
    /// The signed-in user, in this desktop app.
    Here,
    /// The signed-in user, in the desktop app on another computer (or, from the browser, any).
    Elsewhere,
    Someone(&'a str),
}

pub fn editor<'a>(item: &'a FileItem, me: &str) -> Option<Editor<'a>> {
    let lock = item.lock.as_ref().filter(|l| l.expires_at > chrono::Utc::now())?;
    Some(if lock.user_id != me {
        Editor::Someone(&lock.name)
    } else if lock.device_id.as_deref() == tma_client::device_id() {
        Editor::Here
    } else {
        Editor::Elsewhere
    })
}

/// The row's note for a file being edited.
pub fn editing_note(item: &FileItem, me: &str) -> Option<String> {
    editor(item, me).map(|who| match who {
        Editor::Someone(name) => format!("{name} is editing"),
        Editor::Here => "You are editing".into(),
        Editor::Elsewhere if tma_client::device_id().is_none() => "You are editing in the desktop app".into(),
        Editor::Elsewhere => "You are editing on another computer".into(),
    })
}

/// Shared, and the link has not expired.
pub fn is_shared(item: &FileItem) -> bool {
    item.shared && item.expires_at.is_none_or(|at| at > chrono::Utc::now())
}

fn apply_page(
    app: &mut App,
    generation: u64,
    request: u64,
    result: tma_client::ApiResult<tma_client::Listing>,
    append: bool,
) {
    let prefs = app.prefs.clone();
    let Some(main) = app.main_mut(generation) else { return };
    let browser = &mut main.browser;
    if browser.request != request {
        return;
    }
    browser.loading = false;
    browser.loading_more = false;
    match result {
        Ok(page) => {
            if append {
                browser.items.extend(page.files);
            } else {
                browser.items = page.files;
                for item in browser.items.iter().filter(|i| i.is_folder()) {
                    if is_shared(item) {
                        browser.shared_folders.insert(item.id.clone());
                    } else {
                        browser.shared_folders.remove(&item.id);
                    }
                }
                let ids: BTreeSet<String> = browser.items.iter().map(|i| i.id.clone()).collect();
                browser.selected.retain(|id| ids.contains(id));
                // One look at the first page; a later reload must not select it out of nowhere.
                browser.reveal_left_child(false);
                browser.reveal = None;
            }
            browser.cursor = page.next_cursor;
            browser.loaded = true;
            let key = browser.cache_key(&prefs);
            browser.cache.put(key, browser.items.clone(), browser.cursor.clone());
        }
        Err(err) => {
            browser.error = Some(err.message.clone());
            browser.loaded = true;
            app.fail(generation, &err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Place, left_child};

    fn path(ids: &[&str]) -> Vec<(String, String)> {
        ids.iter().map(|id| (id.to_string(), id.to_uppercase())).collect()
    }

    #[test]
    fn going_up_selects_the_folder_left() {
        let deep = path(&["a", "b", "c"]);
        assert_eq!(left_child(&Place::Folder, &deep, &Place::Folder, &path(&["a"])), Some("b".into()));
        assert_eq!(left_child(&Place::Folder, &deep, &Place::Folder, &[]), Some("a".into()));
        assert_eq!(left_child(&Place::Folder, &path(&["a"]), &Place::Folder, &path(&["a", "b"])), None);
        assert_eq!(left_child(&Place::Folder, &deep, &Place::Folder, &path(&["x"])), None);
        assert_eq!(left_child(&Place::Starred, &deep, &Place::Folder, &[]), None);
    }
}
