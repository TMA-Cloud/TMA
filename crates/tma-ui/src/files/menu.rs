//! The right-click menu for the selected items, in the web app's order:
//! sharing and downloads, then starring, the clipboard, details and delete.

use egui::{Align2, Color32, CornerRadius, FontId, RichText, Sense, Ui, Vec2};
use tma_core::Permission;
use tma_core::api::FileItem;

use super::Place;
use super::actions::Action;
use crate::app::Main;
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

/// One menu row; `danger` sets it in the destructive colour.
fn row(ui: &mut Ui, icon: &str, label: &str, danger: bool) -> bool {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 30.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, CornerRadius::same(8), if danger { t.destructive } else { t.fill_quaternary });
    }
    let color = match (danger, response.hovered()) {
        (true, true) => Color32::WHITE,
        (true, false) => t.destructive_text,
        _ => t.label,
    };
    let icon_color = if danger { color } else { t.label_secondary };
    ui.painter().text(
        rect.left_center() + Vec2::new(16.0, 0.0),
        Align2::CENTER_CENTER,
        icon,
        FontId::proportional(15.0),
        icon_color,
    );
    ui.painter().text(
        rect.left_center() + Vec2::new(32.0, 0.0),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(13.0),
        color,
    );
    if response.clicked() {
        ui.close();
    }
    response.clicked()
}

pub(super) fn context_menu(main: &Main, ui: &mut Ui, items: &[FileItem], desktop: bool, actions: &mut Vec<Action>) {
    let t = widgets::tokens(ui);
    ui.set_min_width(210.0);
    ui.set_max_width(230.0);
    ui.spacing_mut().item_spacing.y = 1.0;
    let n = items.len();
    ui.label(
        RichText::new(if n == 1 { "1 item selected".to_string() } else { format!("{n} items selected") })
            .size(11.0)
            .medium()
            .color(t.label_tertiary),
    );
    ui.separator();
    let user = &main.user;
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let mut item = |ui: &mut Ui, icon: &str, label: &str, action: Action| {
        if row(ui, icon, label, false) {
            actions.push(action);
        }
    };
    if main.browser.place == Place::Trash {
        if user.can(Permission::Trash) {
            item(ui, ph::ARROW_COUNTER_CLOCKWISE, "Restore", Action::Restore(ids.clone()));
            if row(ui, ph::TRASH, "Delete forever", true) {
                actions.push(Action::DeleteForever(ids));
            }
        }
        return;
    }
    let single = items.first().filter(|_| n == 1).cloned();
    if let Some(first) = single.clone() {
        item(ui, ph::ARROW_SQUARE_OUT, "Open", Action::Open(first.clone()));
        if matches!(main.browser.place, Place::Search(_) | Place::Starred | Place::Shared) {
            item(ui, ph::FOLDER_OPEN, "Show in folder", Action::OpenLocation(first.clone()));
        }
    }
    if user.can(Permission::Share) {
        item(ui, ph::SHARE_NETWORK, "Share", Action::Share(items.to_vec()));
    }
    if user.can(Permission::Download) {
        item(ui, ph::DOWNLOAD_SIMPLE, "Download", Action::Download(items.to_vec()));
    }
    if let Some(first) = single.clone().filter(|f| desktop && !f.is_folder() && user.can(Permission::Edit)) {
        item(ui, ph::DESKTOP, "Open on desktop", Action::EditInApp(first));
    }
    if desktop && user.can(Permission::Download) {
        item(ui, ph::CLIPBOARD, "Copy to other apps", Action::CopyToSystem(items.to_vec()));
    }
    if user.can(Permission::Edit) {
        let all_starred = items.iter().all(|i| i.starred);
        let label = if all_starred { "Remove from Starred" } else { "Add to Starred" };
        item(ui, ph::STAR, label, Action::Star(ids.clone(), !all_starred));
    }
    if user.can(Permission::Upload) {
        item(ui, ph::COPY, "Copy", Action::Clip(ids.clone(), false));
    }
    if user.can(Permission::Edit) && main.browser.place == Place::Folder {
        item(ui, ph::SCISSORS, "Cut", Action::Clip(ids.clone(), true));
    }
    if let Some(first) = single.clone() {
        item(ui, ph::INFO, "Get info", Action::Info(first));
    }
    if let Some(first) = single.filter(|_| user.can(Permission::Edit)) {
        item(ui, ph::PENCIL_SIMPLE, "Rename", Action::Rename(first));
    }
    if user.can(Permission::Delete) && row(ui, ph::TRASH, "Delete", true) {
        actions.push(Action::Trash(items.to_vec()));
    }
}
