//! Dialogs over the file browser: new folder, rename, confirmations, Get Info,
//! sharing and the image viewer.

use std::collections::BTreeMap;

use egui::{Align2, Color32, Key, RichText, Vec2};
use tma_core::api::{FileInfo, FileItem};

use crate::app::{App, Screen};
use crate::icons::{self, ph};
use crate::theme::Weight;
use crate::widgets;

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
            let close = dialog(ctx, "info", 420.0, "Get Info", |ui| info_body(ui, item, info.as_ref()));
            if close {
                outcome = Some(Outcome::Close);
            }
        }
        Modal::Share(share) => {
            let close = dialog(ctx, "share", 380.0, "Share Options", |ui| share_body(ui, share, &mut outcome));
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

fn info_row(ui: &mut egui::Ui, label: &str, value: String) {
    let t = widgets::tokens(ui);
    ui.horizontal(|ui| {
        ui.add_sized([110.0, 18.0], egui::Label::new(RichText::new(label).color(t.label_secondary)));
        ui.add(egui::Label::new(value).wrap());
    });
}

fn info_body(ui: &mut egui::Ui, item: &FileItem, info: Option<&FileInfo>) {
    let t = widgets::tokens(ui);
    ui.horizontal(|ui| {
        icons::item_icon(ui, 44.0, item.is_folder(), &item.name, item.mime_type.as_deref(), &t);
        ui.vertical(|ui| {
            ui.add(egui::Label::new(RichText::new(&item.name).size(16.0).semibold()).wrap());
            let kind = if item.is_folder() {
                "Folder"
            } else {
                tma_core::file_kind(&item.name, item.mime_type.as_deref()).label()
            };
            ui.label(widgets::muted(ui, kind));
        });
    });
    ui.add_space(10.0);
    widgets::separator(ui);
    let Some(info) = info else {
        ui.spinner();
        return;
    };
    let location = if info.location_path.is_empty() {
        "My Files".to_string()
    } else {
        format!("My Files / {}", info.location_path.join(" / "))
    };
    info_row(ui, "Location", location);
    if let Some(folder) = &info.folder_info {
        info_row(ui, "Size", tma_core::format::file_size(folder.total_size));
        info_row(ui, "Contains", format!("{} files, {} folders", folder.file_count, folder.folder_count));
    } else if let Some(size) = info.size {
        info_row(ui, "Size", tma_core::format::file_size(size));
    }
    info_row(ui, "Modified", tma_core::format::full_date(info.modified));
    if let Some(at) = info.accessed_at {
        info_row(ui, "Last opened", tma_core::format::full_date(at));
    }
    if info.shared {
        info_row(ui, "Shared", tma_core::format::share_remaining(info.expires_at, chrono::Utc::now()));
    }
}

fn share_body(ui: &mut egui::Ui, share: &mut Share, outcome: &mut Option<Outcome>) {
    let t = widgets::tokens(ui);
    let ids: Vec<String> = share.items.iter().map(|i| i.id.clone()).collect();
    if share.links.is_empty() {
        let n = share.items.len();
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing.x = 0.0;
            ui.label(RichText::new("Choose how long the link stays active for ").size(13.0).color(t.label_secondary));
            ui.label(
                RichText::new(if n == 1 { "1 item".to_string() } else { format!("{n} items") }).size(13.0).semibold(),
            );
            ui.label(RichText::new(".").size(13.0).color(t.label_secondary));
        });
        ui.add_space(6.0);
        for (value, label) in [("7d", "7 days"), ("30d", "30 days"), ("never", "No expiration")] {
            if expiry_option(ui, share.expiry == value, label) {
                share.expiry = value;
            }
        }
        widgets::dialog_footer(ui, |ui| {
            if widgets::primary_enabled(ui, !share.busy, "Share").clicked() {
                share.busy = true;
                *outcome = Some(Outcome::ShareSet(ids, true, share.expiry));
            }
            if widgets::secondary(ui, "Cancel").clicked() {
                *outcome = Some(Outcome::Close);
            }
        });
        return;
    }
    for item in &share.items {
        let Some(link) = share.links.get(&item.id) else { continue };
        ui.label(RichText::new(&item.name).size(12.0).color(t.label_secondary));
        ui.horizontal(|ui| {
            let mut text = link.clone();
            ui.add(egui::TextEdit::singleline(&mut text).desired_width(330.0).interactive(true));
            if widgets::secondary(ui, format!("{}  Copy", ph::COPY)).clicked() {
                ui.ctx().copy_text(link.clone());
            }
        });
        ui.add_space(4.0);
    }
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary(ui, "Done").clicked() {
            *outcome = Some(Outcome::Close);
        }
        if widgets::ghost(ui, RichText::new("Stop sharing").color(t.destructive_text)).clicked() {
            share.busy = true;
            *outcome = Some(Outcome::ShareSet(ids, false, "never"));
        }
    });
}

/// One link-expiry choice, a bordered pill; the chosen one is tinted.
fn expiry_option(ui: &mut egui::Ui, chosen: bool, label: &str) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 36.0), egui::Sense::click());
    let (fill, stroke, color) = if chosen {
        (t.accent_fill, t.accent, t.accent)
    } else if response.hovered() {
        (t.fill_quaternary, t.separator_strong, t.label)
    } else {
        (Color32::TRANSPARENT, t.separator_strong, t.label)
    };
    ui.painter().rect(
        rect,
        egui::CornerRadius::same(18),
        fill,
        egui::Stroke::new(1.0, stroke),
        egui::StrokeKind::Inside,
    );
    ui.painter().text(
        rect.left_center() + Vec2::new(20.0, 0.0),
        Align2::CENTER_CENTER,
        ph::CLOCK,
        egui::FontId::proportional(14.0),
        color,
    );
    ui.painter().text(
        rect.left_center() + Vec2::new(36.0, 0.0),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::new(13.0, crate::theme::semibold()),
        color,
    );
    response.clicked()
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
