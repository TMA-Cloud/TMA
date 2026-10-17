//! What the user asked the browser to do. Views only record an `Action`; it
//! runs after the frame with the whole app at hand.

use tma_client::UploadFile;
use tma_core::api::{FileItem, SortBy, SortOrder};

use super::{Clip, Place};
use crate::app::{App, Section};
use crate::modals::{Confirm, Modal};

#[derive(Debug, Clone)]
pub enum Action {
    Open(FileItem),
    /// Jump to a crumb: `None` is the root, `Some(i)` keeps the first `i + 1` crumbs.
    Crumb(Option<usize>),
    NewFolder,
    Rename(FileItem),
    Trash(Vec<FileItem>),
    Restore(Vec<String>),
    DeleteForever(Vec<String>),
    EmptyTrash,
    Star(Vec<String>, bool),
    Clip(Vec<String>, bool),
    Back,
    Forward,
    Paste,
    MoveTo(Vec<String>, Option<String>),
    Download(Vec<FileItem>),
    Share(Vec<FileItem>),
    Info(FileItem),
    /// Open the upload dialog.
    OpenUpload,
    /// Turn the touch selection mode on or off.
    SelectMode(bool),
    /// Show an image in the built-in viewer (the desktop app opens files in their own apps).
    Preview(FileItem),
    /// Copy the share links of shared items.
    CopyLinks(Vec<String>),
    /// Add items to the share of the folder they are in (no new link).
    LinkToFolderShare(Vec<String>),
    PickUpload,
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    PickFolder,
    Refresh,
    LoadMore,
    Sort(SortBy),
    Order(SortOrder),
    Grid(bool),
    EditInApp(FileItem),
    OpenDocument(FileItem),
    OpenLocation(FileItem),
}

/// "1 item", "3 items".
pub(crate) fn items_label(n: usize) -> String {
    if n == 1 { "1 item".into() } else { format!("{n} items") }
}

pub(super) fn ids(items: &[FileItem]) -> Vec<String> {
    items.iter().map(|i| i.id.clone()).collect()
}

/// Queue uploads into the current folder (the root outside My Files).
/// Picked or dropped files: into the upload dialog when it is open, else straight up.
pub fn stage_files(app: &mut App, files: Vec<UploadFile>) {
    if let crate::app::Screen::Main(main) = &mut app.screen
        && let Some(Modal::Upload(staged)) = &mut main.modal
    {
        crate::modals::stage(staged, files);
        return;
    }
    upload_files(app, files);
}

pub fn upload_files(app: &mut App, files: Vec<UploadFile>) {
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    if files.is_empty() {
        return;
    }
    let max = main.instance.max_upload;
    let (ok, too_big): (Vec<UploadFile>, Vec<UploadFile>) =
        files.into_iter().partition(|f| max <= 0 || f.size as i64 <= max);
    if !too_big.is_empty() {
        app.toasts.error(format!(
            "{} file(s) are larger than the {} upload limit",
            too_big.len(),
            tma_core::format::file_size(max)
        ));
    }
    let parent = if main.section == Section::Files { main.browser.folder_id() } else { None };
    // Names are checked against the open folder, which is where these uploads go.
    let here = main.section == Section::Files && main.browser.place == Place::Folder;
    let (clean, clashes) = if here { super::conflicts::split(ok, &main.browser.items) } else { (ok, Vec::new()) };
    if clashes.is_empty() {
        main.transfers.queue_uploads(clean, parent);
        return;
    }
    let clashes = clashes
        .into_iter()
        .map(|(file, existing)| super::conflicts::Clash { file, existing, replace: false })
        .collect();
    main.browser.conflicts = Some(super::conflicts::Pending { parent, clean, clashes });
}

/// Upload files copied in another app (desktop): folders keep their structure.
pub(super) fn paste_system_files(app: &mut App) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let paths = app.host.clipboard_files();
        if paths.is_empty() {
            let contents = app.host.clipboard_contents();
            if !contents.is_empty() {
                upload_files(app, contents);
            }
            return;
        }
        // Walking a large copied folder reads the disk, so it runs off the frame.
        app.tasks.run(async move { crate::platform::uploads_from_paths(&paths) }, upload_files);
    }
    #[cfg(target_arch = "wasm32")]
    let _ = app;
}

pub fn download(app: &mut App, items: Vec<FileItem>) {
    run(app, Action::Download(items));
}

pub fn run(app: &mut App, action: Action) {
    let crate::app::Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    let tasks = &app.tasks;
    let prefs = &app.prefs;
    match action {
        Action::Open(item) if item.is_folder() => {
            if main.browser.place == Place::Trash {
                return;
            }
            main.section = Section::Files;
            main.browser.enter_folder(&item.id, &item.name, tasks, &client, generation, prefs);
        }
        Action::Open(item) => super::open::file(app, item),
        Action::OpenDocument(item) => super::open::document(app, item),
        Action::OpenLocation(item) => super::open::location(app, item),
        Action::Crumb(depth) => {
            let path = match depth {
                None => Vec::new(),
                Some(i) => main.browser.path.iter().take(i + 1).cloned().collect(),
            };
            main.browser.open(Place::Folder, path, tasks, &client, generation, prefs);
        }
        Action::NewFolder => {
            let names = main.browser.items.iter().map(|i| i.name.as_str());
            main.modal = Some(Modal::new_folder(main.browser.folder_id(), names));
        }
        Action::Rename(item) => main.modal = Some(Modal::rename(&item, main.instance.hide_extensions)),
        Action::Info(item) => super::sharing::info(app, item),
        Action::Share(items) => super::sharing::share(app, items),
        Action::Trash(items) => super::jobs::trash(app, items),
        Action::Restore(ids) => super::jobs::restore(app, ids),
        Action::DeleteForever(ids) => {
            let body = format!("{} will be deleted permanently. This cannot be undone.", items_label(ids.len()));
            main.modal = Some(Modal::Confirm(Confirm::new(
                "Delete forever?",
                body,
                "Delete",
                crate::modals::ConfirmAction::DeleteForever(ids),
            )));
        }
        Action::EmptyTrash => {
            main.modal = Some(Modal::Confirm(Confirm::new(
                "Empty trash?",
                "Everything in the trash will be deleted permanently. This cannot be undone.".into(),
                "Empty trash",
                crate::modals::ConfirmAction::EmptyTrash,
            )));
        }
        Action::Star(ids, starred) => super::jobs::star(app, ids, starred),
        Action::Clip(ids, cut) => {
            let n = ids.len();
            let items: Vec<FileItem> = main.browser.items.iter().filter(|i| ids.contains(&i.id)).cloned().collect();
            main.browser.clip = Some(Clip { ids, cut, seq: app.host.clipboard_sequence() });
            if !app.host.clipboard_copy(&client, &items, cut, tasks) {
                let done = if cut { "cut" } else { "copied" };
                app.toasts.info(format!("{} {done}. Paste them in another folder.", items_label(n)));
            }
        }
        Action::Back | Action::Forward => {
            let back = matches!(action, Action::Back);
            if let Some((place, _)) =
                (if back { main.browser.back.last() } else { main.browser.forward.last() }).cloned()
            {
                main.section = match place {
                    Place::Folder => Section::Files,
                    Place::Starred => Section::Starred,
                    Place::Shared => Section::Shared,
                    Place::Trash => Section::Trash,
                    Place::Search(_) => Section::Search,
                };
            }
            main.browser.go(back, tasks, &client, generation, prefs);
        }
        Action::Paste => super::jobs::paste(app),
        Action::MoveTo(ids, target) => super::jobs::move_to(app, ids, target),
        Action::Download(items) => super::download::start_download(app, items),
        Action::OpenUpload => main.modal = Some(Modal::Upload(Vec::new())),
        Action::Preview(item) => {
            let images: Vec<FileItem> =
                main.browser.items.iter().filter(|i| super::open::is_image(i)).cloned().collect();
            let images = if images.iter().any(|i| i.id == item.id) { images } else { vec![item.clone()] };
            let index = images.iter().position(|i| i.id == item.id).unwrap_or(0);
            main.modal = Some(Modal::viewer(images, index));
        }
        Action::CopyLinks(ids) => super::sharing::copy_links(app, ids),
        Action::LinkToFolderShare(ids) => super::sharing::link_to_folder_share(app, ids),
        Action::SelectMode(on) => {
            main.browser.select_mode = on;
            if !on {
                main.browser.selected.clear();
            }
        }
        Action::PickUpload => tasks.run(crate::platform::pick_files(), stage_files),
        Action::PickFolder => tasks.run(crate::platform::pick_folder(), stage_files),
        Action::Refresh => main.browser.reload(tasks, &client, generation, prefs),
        Action::LoadMore => main.browser.load_more(tasks, &client, generation, prefs),
        Action::Sort(sort) => {
            app.prefs.sort = sort;
            let prefs = app.prefs.clone();
            main.browser.reload(&app.tasks, &client, generation, &prefs);
        }
        Action::Order(order) => {
            app.prefs.order = order;
            let prefs = app.prefs.clone();
            main.browser.reload(&app.tasks, &client, generation, &prefs);
        }
        Action::Grid(grid) => app.prefs.grid_view = grid,
        Action::EditInApp(item) => {
            if !app.host.edit_in_app(&client, &item, &app.tasks) {
                app.toasts.info("Editing in a desktop app needs the TMA Cloud desktop app");
            }
        }
    }
}
