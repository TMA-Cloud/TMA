//! What the user asked the browser to do. Views only record an `Action`; it
//! runs after the frame with the whole app at hand.

use tma_client::UploadFile;
use tma_core::Permission;
use tma_core::api::{FileItem, SortBy, SortOrder};

use super::{Clip, Place};
use crate::app::{App, Section};
use crate::host::HostKind;
use crate::icons::ph;
use crate::modals::{Confirm, Modal};
use crate::transfers::State;

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

/// Mark a job's row in the transfers panel done or failed once the server answers.
pub(crate) fn settle_job<T>(app: &mut App, generation: u64, row: u64, result: &tma_client::ApiResult<T>) {
    if let Some(main) = app.main_mut(generation) {
        let state = match result {
            Ok(_) => State::Done,
            Err(err) => State::Failed(err.message.clone()),
        };
        main.transfers.finish(row, state);
    }
}

fn ids(items: &[FileItem]) -> Vec<String> {
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
fn paste_system_files(app: &mut App) {
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

/// Whether OnlyOffice can open this file.
fn is_document(name: &str) -> bool {
    const EXTS: &[&str] = &[
        "docx", "doc", "docm", "dotx", "dotm", "dot", "xlsx", "xls", "xlsm", "xlsb", "xltx", "xltm", "csv", "pptx",
        "ppt", "pptm", "ppsx", "ppsm", "pps", "potx", "potm", "odt", "ods", "odp", "pdf",
    ];
    EXTS.contains(&tma_core::names::extension_of(name).as_str())
}

pub(super) fn is_image(item: &FileItem) -> bool {
    item.mime_type.as_deref().is_some_and(|m| m.starts_with("image/") && m != "image/svg+xml")
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
        Action::Open(item) => {
            if main.browser.place == Place::Trash {
                app.toasts.info("Restore the file to open it");
            } else if !main.user.can(Permission::Download) {
                // Every way of opening reads the file, which the server allows only with Download.
                app.toasts.error("You don't have permission to open files. Ask the account owner.");
            } else if app.host.kind() == HostKind::Desktop {
                // The desktop app hands every file to the computer, which opens it in its own app.
                run(app, Action::EditInApp(item));
            } else if is_image(&item) {
                run(app, Action::Preview(item));
            } else if is_document(&item.name) && main.instance.onlyoffice {
                run(app, Action::OpenDocument(item));
            } else {
                run(app, Action::Download(vec![item]));
            }
        }
        Action::OpenDocument(item) => {
            let theme = if app.t.dark { "dark" } else { "light" };
            let tab = client.url(&format!("/api/onlyoffice/viewer/{}?theme={theme}", item.id));
            match app.host.kind() {
                // On a phone the editor gets the whole tab, as before.
                HostKind::Web if crate::widgets::mobile(app.tasks.ctx()) => app.host.open_url(&tab),
                HostKind::Web => {
                    let css = |c: egui::Color32| format!("rgb({},{},{})", c.r(), c.g(), c.b());
                    let t = app.t;
                    let look = crate::document::Look {
                        background: css(t.canvas),
                        surface: css(t.surface),
                        text: css(t.label),
                        separator: css(t.separator),
                    };
                    let theme = theme.to_string();
                    tasks.run(
                        async move {
                            let reply = client.document_editor(&item.id, &theme).await.map_err(|e| e.message)?;
                            crate::document::open(&item.name, reply, &look, &tab).await
                        },
                        |app, result: Result<(), String>| {
                            if let Err(err) = result {
                                app.toasts.error(err);
                            }
                        },
                    );
                }
                HostKind::Desktop => {
                    let theme = theme.to_string();
                    tasks.run(async move { client.onlyoffice_ticket(&item.id, &theme).await }, move |app, result| {
                        match result {
                            Ok(url) => app.host.open_url(&url),
                            Err(err) => app.fail(generation, &err),
                        }
                    });
                }
            }
        }
        Action::OpenLocation(item) => {
            // Search results and Recent show items from anywhere; this opens the folder holding one.
            main.section = Section::Files;
            let parent = item.parent_id.clone();
            let c = client.clone();
            tasks.run(
                async move {
                    match parent {
                        Some(p) => c.info(&p).await.map(|info| vec![(info.id, info.name)]),
                        None => Ok(Vec::new()),
                    }
                },
                move |app, result| {
                    let prefs = app.prefs.clone();
                    let crate::app::Screen::Main(main) = &mut app.screen else { return };
                    if main.generation != generation {
                        return;
                    }
                    let path = result.unwrap_or_default();
                    let client = main.client.clone();
                    main.browser.open(Place::Folder, path, &app.tasks, &client, generation, &prefs);
                    main.browser.select_only(&item.id);
                },
            );
        }
        Action::Crumb(depth) => {
            let path = match depth {
                None => Vec::new(),
                Some(i) => main.browser.path.iter().take(i + 1).cloned().collect(),
            };
            main.browser.open(Place::Folder, path, tasks, &client, generation, prefs);
        }
        Action::NewFolder => {
            main.modal = Some(Modal::NewFolder { name: String::new(), parent: main.browser.folder_id() })
        }
        Action::Rename(item) => main.modal = Some(Modal::rename(&item, main.instance.hide_extensions)),
        Action::Info(item) => {
            main.modal = Some(Modal::Info { item: item.clone(), info: None });
            let id = item.id.clone();
            tasks.run(async move { client.info(&id).await }, move |app, result| {
                app.finish(generation, result, |main, _, info| {
                    if let Some(Modal::Info { info: slot, item }) = &mut main.modal
                        && item.id == info.id
                    {
                        *slot = Some(info);
                    }
                });
            });
        }
        Action::Share(items) => {
            let ids = ids(&items);
            main.modal = Some(Modal::share(items));
            tasks.run(async move { client.share_links(&ids).await }, move |app, result| {
                app.finish(generation, result, |main, _, links| {
                    if let Some(Modal::Share(share)) = &mut main.modal {
                        share.links = links.links;
                    }
                });
            });
        }
        Action::Trash(items) => {
            let count = items.len();
            let ids = ids(&items);
            main.browser.items.retain(|i| !ids.contains(&i.id));
            main.browser.selected.clear();
            let row = main.transfers.start_job(format!("Moving {} to the trash", items_label(count)), ph::TRASH);
            tasks.run(
                async move {
                    let queued = client.trash(&ids).await?;
                    if let Some(job) = &queued.job_id {
                        client.wait_for_job(job).await?;
                    }
                    Ok(())
                },
                move |app, result: tma_client::ApiResult<()>| {
                    settle_job(app, generation, row, &result);
                    app.finish(generation, result, |main, _, ()| {
                        main.change_pending = true;
                    });
                },
            );
        }
        Action::Restore(ids) => {
            main.browser.items.retain(|i| !ids.contains(&i.id));
            let count = ids.len();
            let row =
                main.transfers.start_job(format!("Restoring {}", items_label(count)), ph::ARROW_COUNTER_CLOCKWISE);
            tasks.run(
                async move {
                    let queued = client.restore(&ids).await?;
                    if let Some(job) = &queued.job_id {
                        client.wait_for_job(job).await?;
                    }
                    Ok(())
                },
                move |app, result: tma_client::ApiResult<()>| {
                    settle_job(app, generation, row, &result);
                    app.finish(generation, result, |main, _, ()| {
                        main.change_pending = true;
                    });
                },
            );
        }
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
        Action::Star(ids, starred) => {
            for item in main.browser.items.iter_mut().filter(|i| ids.contains(&i.id)) {
                item.starred = starred;
            }
            if !starred && main.browser.place == Place::Starred {
                main.browser.items.retain(|i| !ids.contains(&i.id));
            }
            tasks.run(async move { client.star(&ids, starred).await }, move |app, result| {
                app.finish(generation, result, |main, _, _| main.change_pending = true);
            });
        }
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
        Action::Paste => {
            if main.browser.place != Place::Folder {
                return;
            }
            let in_app = main.browser.clip.as_ref().map(|c| c.seq);
            match super::paste::source(in_app, app.host.clipboard_has_files(), app.host.clipboard_sequence()) {
                super::paste::Source::System => return paste_system_files(app),
                super::paste::Source::Nothing => return,
                super::paste::Source::InApp => {}
            }
            let Some(clip) = main.browser.clip.clone() else { return };
            let target = main.browser.folder_id();
            if clip.cut {
                main.browser.clip = None;
                run(app, Action::MoveTo(clip.ids, target));
            } else {
                let row = main.transfers.start_job(format!("Copying {}", items_label(clip.ids.len())), ph::COPY);
                tasks.run(
                    async move {
                        let queued = client.copy_items(&clip.ids, target.as_deref()).await?;
                        if let Some(job) = queued.job_id {
                            client.wait_for_job(&job).await?;
                        }
                        Ok(clip.ids.len())
                    },
                    move |app, result: tma_client::ApiResult<usize>| {
                        settle_job(app, generation, row, &result);
                        app.finish(generation, result, |main, _, _| {
                            main.change_pending = true;
                        });
                    },
                );
            }
        }
        Action::MoveTo(ids, target) => {
            if target.as_ref().is_some_and(|t| ids.contains(t)) {
                return;
            }
            main.browser.items.retain(|i| !ids.contains(&i.id));
            let row = main.transfers.start_job(format!("Moving {}", items_label(ids.len())), ph::ARROWS_OUT_CARDINAL);
            tasks.run(
                async move { client.move_items(&ids, target.as_deref()).await.map(|_| ids.len()) },
                move |app, result| {
                    settle_job(app, generation, row, &result);
                    app.finish(generation, result, |main, _, _| {
                        main.change_pending = true;
                    });
                },
            );
        }
        Action::Download(items) => super::download::start_download(app, items),
        Action::OpenUpload => main.modal = Some(Modal::Upload(Vec::new())),
        Action::Preview(item) => {
            let images: Vec<FileItem> = main.browser.items.iter().filter(|i| is_image(i)).cloned().collect();
            let images = if images.iter().any(|i| i.id == item.id) { images } else { vec![item.clone()] };
            let index = images.iter().position(|i| i.id == item.id).unwrap_or(0);
            main.modal = Some(Modal::viewer(images, index));
        }
        Action::CopyLinks(ids) => {
            tasks.run(async move { client.share_links(&ids).await }, move |app, result| {
                let ctx = app.tasks.ctx().clone();
                app.finish(generation, result, |_, toasts, links| {
                    let list: Vec<String> = links.links.into_values().collect();
                    if !list.is_empty() {
                        ctx.copy_text(list.join("\n"));
                        toasts.success(if list.len() == 1 {
                            "Link copied".to_string()
                        } else {
                            format!("{} links copied", list.len())
                        });
                    }
                });
            });
        }
        Action::LinkToFolderShare(ids) => {
            tasks.run(async move { client.link_parent_share(&ids).await }, move |app, result| {
                app.finish(generation, result, |main, toasts, _| {
                    toasts.success("Linked to the folder's share");
                    main.change_pending = true;
                });
            });
        }
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
