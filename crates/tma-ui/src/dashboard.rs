//! The home screen: counts, quick actions and recently opened files.

use egui::{Align2, CornerRadius, FontId, RichText, Sense, Stroke, Ui, Vec2};
use tma_client::Client;
use tma_core::Permission;
use tma_core::api::{FileItem, FileStats};

use crate::app::{App, Screen, Section};
use crate::files::{Action, Place, run_action};
use crate::icons::{self, ph};
use crate::tasks::Tasks;
use crate::theme::{self, Weight};
use crate::widgets;

#[derive(Default)]
pub struct Dashboard {
    pub stats: Option<FileStats>,
    pub recent: Vec<FileItem>,
    pub loaded: bool,
}

pub fn load(tasks: &Tasks, client: &Client, generation: u64) {
    let c = client.clone();
    tasks.run(async move { (c.stats().await, c.recent(5).await) }, move |app, (stats, recent)| {
        let Some(main) = app.main_mut(generation) else { return };
        if let Ok(stats) = stats {
            main.dashboard.stats = Some(stats);
        }
        if let Ok(recent) = recent {
            main.dashboard.recent = recent;
        }
        main.dashboard.loaded = true;
    });
}

fn card_shape(ui: &Ui, rect: egui::Rect, hovered: bool) {
    let t = widgets::tokens(ui);
    let fill = if hovered { t.surface_raised } else { t.surface };
    ui.painter().rect(rect, CornerRadius::same(18), fill, Stroke::new(1.0, t.separator), egui::StrokeKind::Inside);
}

fn stat(ui: &mut Ui, value: Option<i64>, label: &str, width: f32) {
    let t = widgets::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(width, 78.0), Sense::hover());
    card_shape(ui, rect, false);
    let text = value.map(|v| v.to_string()).unwrap_or_else(|| "—".into());
    ui.painter().text(
        rect.left_top() + Vec2::new(18.0, 14.0),
        Align2::LEFT_TOP,
        text,
        FontId::new(28.0, theme::bold()),
        t.label,
    );
    ui.painter().text(
        rect.left_bottom() + Vec2::new(18.0, -14.0),
        Align2::LEFT_BOTTOM,
        label,
        FontId::proportional(12.0),
        t.label_tertiary,
    );
}

fn quick(ui: &mut Ui, icon: &str, color: egui::Color32, label: &str, width: f32) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(width, 80.0), Sense::click());
    card_shape(ui, rect, response.hovered());
    ui.painter().text(
        rect.left_top() + Vec2::new(18.0, 18.0),
        Align2::LEFT_TOP,
        icon,
        FontId::proportional(17.0),
        color,
    );
    ui.painter().text(
        rect.left_bottom() + Vec2::new(18.0, -18.0),
        Align2::LEFT_BOTTOM,
        label,
        FontId::new(14.0, theme::semibold()),
        t.label,
    );
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response.clicked()
}

/// Four cards to a row, or two when four would be narrower than this.
const MIN_CARD: f32 = 120.0;
/// The column the dashboard sits in, centred in wider windows.
const CONTENT_WIDTH: f32 = 832.0;

fn card_width(ui: &Ui) -> f32 {
    let (room, gap) = (ui.available_width(), ui.spacing().item_spacing.x);
    let four = (room - 3.0 * gap) / 4.0;
    if four >= MIN_CARD { four } else { ((room - gap) / 2.0).max(MIN_CARD) }
}

fn section_title(ui: &mut Ui, text: &str) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new(text).size(17.0).semibold().color(t.label));
    ui.add_space(4.0);
}

pub fn show(app: &mut App, ui: &mut Ui) {
    let t = app.t;
    let mut actions: Vec<Action> = Vec::new();
    let mut go: Option<(Section, Place)> = None;
    let Screen::Main(main) = &mut app.screen else { return };
    egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
        let width = ui.available_width().min(CONTENT_WIDTH);
        let inset = (ui.available_width() - width) / 2.0;
        ui.horizontal(|ui| {
            ui.add_space(inset);
            ui.vertical(|ui| {
                ui.set_width(width);
                ui.spacing_mut().item_spacing = Vec2::new(10.0, 10.0);
                ui.add_space(8.0);
                ui.label(RichText::new("Welcome back").size(28.0).bold().color(t.label));
                ui.add_space(-6.0);
                ui.label(RichText::new("Here is where your files stand today.").size(14.0).color(t.label_secondary));
                ui.add_space(16.0);
                let card = card_width(ui);
                let s = main.dashboard.stats;
                ui.horizontal_wrapped(|ui| {
                    stat(ui, s.map(|s| s.total_files), "Files", card);
                    stat(ui, s.map(|s| s.total_folders), "Folders", card);
                    stat(ui, s.map(|s| s.shared_count), "Shared", card);
                    stat(ui, s.map(|s| s.starred_count), "Starred", card);
                });
                ui.add_space(18.0);
                section_title(ui, "Quick actions");
                ui.horizontal_wrapped(|ui| {
                    if main.user.can(Permission::Upload) && quick(ui, ph::UPLOAD_SIMPLE, t.accent, "Upload files", card)
                    {
                        actions.push(Action::OpenUpload);
                    }
                    if main.user.can(Permission::Upload) && quick(ui, ph::FOLDER_PLUS, t.positive, "New folder", card) {
                        go = Some((Section::Files, Place::Folder));
                        actions.push(Action::NewFolder);
                    }
                    if quick(ui, ph::SHARE_NETWORK, t.accent, "Shared", card) {
                        go = Some((Section::Shared, Place::Shared));
                    }
                    if quick(ui, ph::STAR, t.warning, "Starred", card) {
                        go = Some((Section::Starred, Place::Starred));
                    }
                });
                ui.add_space(18.0);
                recent(main, ui, &t, &mut actions);
                ui.add_space(24.0);
            });
        });
    });
    if let Some((section, place)) = go {
        crate::shell::navigate(app, section, place);
    }
    for action in actions {
        run_action(app, action);
    }
}

fn recent(main: &crate::app::Main, ui: &mut Ui, t: &crate::theme::Tokens, actions: &mut Vec<Action>) {
    egui::Frame::new()
        .fill(t.surface)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(18))
        .inner_margin(egui::Margin::same(20))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.spacing_mut().item_spacing.y = 2.0;
            section_title(ui, "Recent files");
            ui.add_space(4.0);
            if main.dashboard.loaded && main.dashboard.recent.is_empty() {
                ui.label(RichText::new("Files you open appear here.").size(13.0).color(t.label_tertiary));
            }
            if !main.dashboard.loaded {
                ui.spinner();
            }
            let now = chrono::Utc::now();
            for item in &main.dashboard.recent {
                let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 54.0), Sense::click());
                if response.hovered() {
                    ui.painter().rect_filled(rect, 12.0, t.fill_quaternary);
                }
                let opening = crate::files::opening::look(ui.ctx(), &item.id);
                let icon = egui::Rect::from_center_size(rect.left_center() + Vec2::new(21.0, 0.0), Vec2::splat(26.0));
                crate::files::opening::paint(ui.painter(), rect, 12, icon, opening, t);
                let icon = crate::files::opening::icon_rect(icon, opening);
                icons::file(ui.painter(), icon, t, &item.name, item.mime_type.as_deref());
                ui.painter().text(
                    rect.left_center() + Vec2::new(44.0, -9.0),
                    Align2::LEFT_CENTER,
                    &item.name,
                    FontId::new(14.0, theme::semibold()),
                    t.label,
                );
                let opened = opened_line(item, now, &main.user.id);
                let meta = format!("{}  ·  {opened}", item.size.map(tma_core::format::file_size).unwrap_or_default());
                ui.painter().text(
                    rect.left_center() + Vec2::new(44.0, 10.0),
                    Align2::LEFT_CENTER,
                    meta,
                    FontId::proportional(12.0),
                    t.label_tertiary,
                );
                if response.double_clicked() || response.clicked() {
                    actions.push(Action::Open(item.clone()));
                }
                let item = item.clone();
                response.context_menu(|ui| {
                    if ui.button(format!("{}  Open", ph::ARROW_SQUARE_OUT)).clicked() {
                        actions.push(Action::Open(item.clone()));
                        ui.close();
                    }
                    if ui.button(format!("{}  Show in folder", ph::FOLDER_OPEN)).clicked() {
                        actions.push(Action::OpenLocation(item.clone()));
                        ui.close();
                    }
                    if ui.button(format!("{}  Download", ph::DOWNLOAD_SIMPLE)).clicked() {
                        actions.push(Action::Download(vec![item.clone()]));
                        ui.close();
                    }
                });
            }
        });
}

/// "Opened 2:18 AM by Sam Rivera": when, and which of the account's people
/// (the owner or a sub-user) opened it; "by you" for the one signed in.
fn opened_line(item: &FileItem, now: chrono::DateTime<chrono::Utc>, me: &str) -> String {
    let Some(at) = item.accessed_at else { return String::new() };
    let when = format!("Opened {}", tma_core::format::relative_date(at, now));
    match &item.opened_by {
        Some(o) if o.id == me => format!("{when} by you"),
        Some(o) if !o.name.is_empty() => format!("{when} by {}", o.name),
        _ => when,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tma_core::api::Opener;

    #[test]
    fn recent_files_say_who_opened_them() {
        let now = chrono::Utc::now();
        let mut item = FileItem { accessed_at: Some(now - chrono::Duration::days(30)), ..FileItem::default() };
        let when = format!("Opened {}", tma_core::format::relative_date(now - chrono::Duration::days(30), now));
        assert_eq!(opened_line(&item, now, "me"), when);
        item.opened_by = Some(Opener { id: "sub".into(), name: "Sam Rivera".into() });
        assert_eq!(opened_line(&item, now, "me"), format!("{when} by Sam Rivera"));
        assert_eq!(opened_line(&item, now, "sub"), format!("{when} by you"));
        item.accessed_at = None;
        assert_eq!(opened_line(&item, now, "me"), "");
    }
}
