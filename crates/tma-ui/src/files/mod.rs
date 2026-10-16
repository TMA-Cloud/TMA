//! The file browser: one listing (a folder, Starred, Shared, Trash or search
//! results), its selection and clipboard, paged in from the server.

mod actions;
mod conflicts;
mod download;
mod grid;
mod keys;
mod marquee;
mod menu;
mod paste;
mod thumbs;
mod toolbar;
mod view;

pub use actions::{Action, download, run as run_action, upload_files};
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
        self.show(place, path, tasks, client, generation, prefs);
    }

    /// Step through history: `true` goes back, `false` forward.
    pub fn go(&mut self, back: bool, tasks: &Tasks, client: &Client, generation: u64, prefs: &Prefs) {
        let (from, to) = if back { (&mut self.back, &mut self.forward) } else { (&mut self.forward, &mut self.back) };
        let Some((place, path)) = from.pop() else { return };
        to.push((self.place.clone(), self.path.clone()));
        self.show(place, path, tasks, client, generation, prefs);
    }

    fn show(
        &mut self,
        place: Place,
        path: Vec<(String, String)>,
        tasks: &Tasks,
        client: &Client,
        generation: u64,
        prefs: &Prefs,
    ) {
        self.place = place;
        self.path = path;
        self.scroll_to = None;
        self.items.clear();
        self.selected.clear();
        self.anchor = None;
        self.loaded = false;
        self.load(tasks, client, generation, prefs);
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

fn apply_page(
    app: &mut App,
    generation: u64,
    request: u64,
    result: tma_client::ApiResult<tma_client::Listing>,
    append: bool,
) {
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
                let ids: BTreeSet<String> = browser.items.iter().map(|i| i.id.clone()).collect();
                browser.selected.retain(|id| ids.contains(id));
            }
            browser.cursor = page.next_cursor;
            browser.loaded = true;
        }
        Err(err) => {
            browser.error = Some(err.message.clone());
            browser.loaded = true;
            app.fail(generation, &err);
        }
    }
}
