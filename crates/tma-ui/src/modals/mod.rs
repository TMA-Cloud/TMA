//! Dialogs over the file browser: new folder, rename, confirmations, Get Info,
//! sharing and the image viewer.

use std::collections::BTreeMap;

use egui::{Key, RichText};
use tma_core::api::{FileInfo, FileItem};

use crate::app::{App, Screen};
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

mod info;
mod share;
mod upload;
mod viewer;

pub use upload::add as stage;
pub use viewer::Viewer;
use viewer::{decode, viewer_overlay};

#[derive(Debug, Clone)]
pub enum ConfirmAction {
    DeleteForever(Vec<String>),
    EmptyTrash,
}

pub struct Confirm {
    pub title: String,
    pub body: String,
    pub button: String,
    pub action: ConfirmAction,
}

impl Confirm {
    pub fn new(title: &str, body: String, button: &str, action: ConfirmAction) -> Self {
        Self { title: title.into(), body, button: button.into(), action }
    }
}

pub struct Share {
    pub items: Vec<FileItem>,
    pub links: BTreeMap<String, String>,
    pub expiry: &'static str,
    pub busy: bool,
}

pub enum Modal {
    NewFolder {
        name: String,
        parent: Option<String>,
    },
    Rename {
        item: FileItem,
        name: String,
    },
    Confirm(Confirm),
    Info {
        item: FileItem,
        info: Option<FileInfo>,
    },
    Share(Share),
    Viewer(Viewer),
    /// Files and folders gathered for upload, before they are sent.
    Upload(Vec<tma_client::UploadFile>),
    /// Uploads that failed, grouped by reason, kept until the user dismisses them.
    UploadIssues(Vec<(String, Vec<String>)>),
}

impl Modal {
    pub fn rename(item: &FileItem, hide_extensions: bool) -> Self {
        let name = tma_core::names::display_name(&item.name, !item.is_folder(), hide_extensions).to_string();
        Self::Rename { item: item.clone(), name }
    }

    pub fn share(items: Vec<FileItem>) -> Self {
        Self::Share(Share { items, links: BTreeMap::new(), expiry: "7d", busy: false })
    }

    pub fn viewer(items: Vec<FileItem>, index: usize) -> Self {
        Self::Viewer(Viewer::new(items, index))
    }
}

enum Outcome {
    Close,
    CreateFolder(String, Option<String>),
    Rename(String, String),
    Confirmed(ConfirmAction),
    ShareSet(Vec<String>, bool, &'static str),
    LoadImage(String),
    Download(FileItem),
    /// Add files (`true`: a folder) to the upload dialog.
    Pick(bool),
    Upload,
}

/// A dialog with the standard header; true when it should close (Esc, backdrop or the close button).
fn dialog(ctx: &egui::Context, id: &str, width: f32, title: &str, add: impl FnOnce(&mut egui::Ui)) -> bool {
    let mut closed = false;
    let response = widgets::modal(ctx, id).show(ctx, |ui| {
        ui.set_min_width(width);
        ui.set_max_width(width);
        closed = widgets::dialog_header(ui, title);
        add(ui);
    });
    response.should_close() || closed
}

pub fn show(app: &mut App, ctx: &egui::Context) {
    let t = app.t;
    let Screen::Main(main) = &mut app.screen else { return };
    let Some(modal) = &mut main.modal else { return };
    let mut outcome = None;
    let hide_ext = main.instance.hide_extensions;
    match modal {
        Modal::NewFolder { name, parent } => {
            let close = dialog(ctx, "new-folder", 380.0, "New Folder", |ui| {
                ui.label(RichText::new("Folder name").size(12.0).semibold());
                let r = widgets::text_edit(ui, name, "", f32::INFINITY);
                r.request_focus();
                let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
                widgets::dialog_footer(ui, |ui| {
                    let ok = !name.trim().is_empty();
                    if widgets::primary_enabled(ui, ok, "Create").clicked() || (enter && ok) {
                        outcome = Some(Outcome::CreateFolder(name.trim().to_string(), parent.clone()));
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        outcome = Some(Outcome::Close);
                    }
                });
            });
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Rename { item, name } => {
            let close = dialog(ctx, "rename", 400.0, "Rename", |ui| {
                ui.label(RichText::new("New name").size(12.0).semibold());
                let r = widgets::text_edit(ui, name, "", f32::INFINITY);
                r.request_focus();
                let enter = r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
                widgets::dialog_footer(ui, |ui| {
                    let ok = !name.trim().is_empty();
                    if widgets::primary_enabled(ui, ok, "Rename").clicked() || (enter && ok) {
                        let full = if hide_ext && !item.is_folder() {
                            tma_core::names::full_name_for_rename(name.trim(), &item.name)
                        } else {
                            name.trim().to_string()
                        };
                        outcome = Some(Outcome::Rename(item.id.clone(), full));
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        outcome = Some(Outcome::Close);
                    }
                });
            });
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Confirm(c) => {
            let close = dialog(ctx, "confirm", 400.0, &c.title.clone(), |ui| {
                ui.label(widgets::muted(ui, &c.body));
                widgets::dialog_footer(ui, |ui| {
                    if widgets::danger(ui, &c.button).clicked() {
                        outcome = Some(Outcome::Confirmed(c.action.clone()));
                    }
                    if widgets::secondary(ui, "Cancel").clicked() {
                        outcome = Some(Outcome::Close);
                    }
                });
            });
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Info { item, info } => {
            let close = dialog(ctx, "info", 420.0, "Get Info", |ui| info::info_body(ui, item, info.as_ref()));
            if close {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Share(share) => {
            let close = dialog(ctx, "share", 380.0, "Share Options", |ui| share::share_body(ui, share, &mut outcome));
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Viewer(viewer) => viewer_overlay(ctx, &t, viewer, &mut outcome),
        Modal::Upload(staged) => {
            let close = dialog(ctx, "upload", 520.0, "Upload", |ui| upload::body(ui, staged, &mut outcome));
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::UploadIssues(groups) => {
            let count: usize = groups.iter().map(|(_, names)| names.len()).sum();
            let title = format!("{} not uploaded", if count == 1 { "1 file".into() } else { format!("{count} files") });
            let close = dialog(ctx, "upload-issues", 460.0, &title, |ui| issues_body(ui, groups, &mut outcome));
            if close && outcome.is_none() {
                outcome = Some(Outcome::Close);
            }
        }
    }
    if let Some(outcome) = outcome {
        apply(app, outcome);
    }
}

/// Enough names to see the shape of the problem; the dialog still opens at once after a huge folder.
const ISSUE_NAMES: usize = 50;

fn issues_body(ui: &mut egui::Ui, groups: &[(String, Vec<String>)], outcome: &mut Option<Outcome>) {
    let t = widgets::tokens(ui);
    egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
        for (reason, names) in groups {
            ui.label(RichText::new(reason).semibold());
            for name in names.iter().take(ISSUE_NAMES) {
                ui.add(egui::Label::new(RichText::new(name).size(12.0).color(t.label_secondary)).truncate());
            }
            if names.len() > ISSUE_NAMES {
                ui.label(widgets::muted(ui, format!("and {} more", names.len() - ISSUE_NAMES)));
            }
            ui.add_space(8.0);
        }
    });
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary(ui, "OK").clicked() {
            *outcome = Some(Outcome::Close);
        }
        if widgets::secondary(ui, format!("{}  Copy details", ph::COPY)).clicked() {
            let details: Vec<String> =
                groups.iter().flat_map(|(reason, names)| names.iter().map(move |n| format!("{n}: {reason}"))).collect();
            ui.ctx().copy_text(details.join("\n"));
        }
    });
}

fn apply(app: &mut App, outcome: Outcome) {
    let Screen::Main(main) = &mut app.screen else { return };
    let (client, generation) = (main.client.clone(), main.generation);
    match outcome {
        Outcome::Close => main.modal = None,
        Outcome::CreateFolder(name, parent) => {
            main.modal = None;
            app.tasks.run(async move { client.create_folder(&name, parent.as_deref()).await }, move |app, result| {
                app.finish(generation, result, |main, toasts, folder| {
                    toasts.success(format!("Created “{}”", folder.name));
                    main.change_pending = true;
                });
            });
        }
        Outcome::Rename(id, name) => {
            main.modal = None;
            app.tasks.run(async move { client.rename(&id, &name).await }, move |app, result| {
                app.finish(generation, result, |main, _, item| {
                    if let Some(row) = main.browser.items.iter_mut().find(|i| i.id == item.id) {
                        row.name = item.name;
                    }
                    main.change_pending = true;
                });
            });
        }
        Outcome::Confirmed(action) => {
            main.modal = None;
            let title = match &action {
                ConfirmAction::DeleteForever(ids) => {
                    format!("Deleting {} forever", crate::files::items_label(ids.len()))
                }
                ConfirmAction::EmptyTrash => "Emptying the trash".to_string(),
            };
            let row = main.transfers.start_job(title, ph::TRASH);
            app.tasks.run(
                async move {
                    let queued = match &action {
                        ConfirmAction::DeleteForever(ids) => client.delete_forever(ids).await?,
                        ConfirmAction::EmptyTrash => client.empty_trash().await?,
                    };
                    if let Some(job) = &queued.job_id {
                        client.wait_for_job(job).await?;
                    }
                    Ok(queued.message)
                },
                move |app, result: tma_client::ApiResult<String>| {
                    crate::files::settle_job(app, generation, row, &result);
                    app.finish(generation, result, |main, _, _| main.change_pending = true);
                },
            );
        }
        Outcome::ShareSet(ids, shared, expiry) => {
            app.tasks.run(async move { client.share(&ids, shared, Some(expiry)).await }, move |app, result| {
                app.finish(generation, result, |main, toasts, links| {
                    if shared {
                        if let Some(Modal::Share(share)) = &mut main.modal {
                            share.links = links.links;
                            share.busy = false;
                        }
                    } else {
                        main.modal = None;
                        toasts.success("Stopped sharing");
                    }
                    main.change_pending = true;
                });
            });
        }
        Outcome::LoadImage(id) => {
            let ctx = app.tasks.ctx().clone();
            app.tasks.run(
                async move {
                    let bytes = client.file_bytes(&id).await.map_err(|e| e.message)?;
                    decode(&bytes).map(|image| (id, image)).map_err(|e| e.to_string())
                },
                move |app, result: Result<(String, egui::ColorImage), String>| {
                    let Some(main) = app.main_mut(generation) else { return };
                    let Some(Modal::Viewer(viewer)) = &mut main.modal else { return };
                    let id = viewer.loading.take().unwrap_or_default();
                    match result {
                        Ok((id, image)) => {
                            let texture = ctx.load_texture(format!("viewer-{id}"), image, egui::TextureOptions::LINEAR);
                            viewer.textures.insert(id, texture);
                        }
                        Err(err) => {
                            viewer.failed.insert(id, err);
                        }
                    }
                },
            );
        }
        Outcome::Download(item) => crate::files::download(app, vec![item]),
        Outcome::Pick(folder) => {
            let pick = if folder { crate::files::Action::PickFolder } else { crate::files::Action::PickUpload };
            crate::files::run_action(app, pick);
        }
        Outcome::Upload => {
            let Some(Modal::Upload(staged)) = main.modal.take() else { return };
            crate::files::upload_files(app, staged);
        }
    }
}
