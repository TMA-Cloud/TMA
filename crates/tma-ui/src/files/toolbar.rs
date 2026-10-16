//! The bar above the listing, a rounded card as in the web app: history and
//! breadcrumbs on the left, icon actions for the selection and the view on the right.

use egui::{Align2, Color32, CornerRadius, FontId, RichText, Sense, Stroke, Ui, Vec2};
use tma_core::Permission;
use tma_core::api::{FileItem, SortBy, SortOrder};

use super::Place;
use super::actions::Action;
use crate::app::{Main, Prefs};
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

/// An icon button in the bar; `active` marks the current view mode.
fn tool(ui: &mut Ui, icon: &str, tip: &str, active: bool, color: Option<Color32>) -> egui::Response {
    let t = widgets::tokens(ui);
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::click());
    let fill = if active {
        t.accent_fill
    } else if response.hovered() {
        t.fill_quaternary
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, CornerRadius::same(8), fill);
    let color = color.unwrap_or(if active {
        t.accent
    } else if response.hovered() {
        t.label
    } else {
        t.label_secondary
    });
    ui.painter().text(rect.center(), Align2::CENTER_CENTER, icon, FontId::proportional(18.0), color);
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response.on_hover_text(tip)
}

fn divider(ui: &mut Ui) {
    let t = widgets::tokens(ui);
    let (rect, _) = ui.allocate_exact_size(Vec2::new(13.0, 20.0), Sense::hover());
    ui.painter().vline(rect.center().x, rect.y_range(), Stroke::new(1.0, t.separator));
}

/// Back and forward in a small segmented pill, shown once there is history.
fn history(main: &Main, ui: &mut Ui, actions: &mut Vec<Action>) {
    let t = widgets::tokens(ui);
    let b = &main.browser;
    if b.back.is_empty() && b.forward.is_empty() {
        return;
    }
    egui::Frame::new()
        .fill(t.fill_quaternary)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(egui::Margin::same(3))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.x = 2.0;
            ui.add_enabled_ui(!b.back.is_empty(), |ui| {
                if tool(ui, ph::ARROW_LEFT, "Back", false, None).clicked() {
                    actions.push(Action::Back);
                }
            });
            ui.add_enabled_ui(!b.forward.is_empty(), |ui| {
                if tool(ui, ph::ARROW_RIGHT, "Forward", false, None).clicked() {
                    actions.push(Action::Forward);
                }
            });
        });
    ui.add_space(6.0);
}

fn crumb(ui: &mut Ui, text: &str, current: bool) -> egui::Response {
    let t = widgets::tokens(ui);
    let rich = if current {
        RichText::new(text).size(13.0).semibold().color(t.label)
    } else {
        RichText::new(text).size(13.0).color(t.label_secondary)
    };
    let response = ui.add(egui::Label::new(rich).sense(Sense::click()).truncate());
    if response.hovered() && !current {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    response
}

fn chevron(ui: &mut Ui) {
    let t = widgets::tokens(ui);
    ui.label(RichText::new(ph::CARET_RIGHT).size(12.0).color(t.label_quaternary));
}

/// Home, then the folders down to the open one; other places show their name.
fn crumbs(main: &Main, ui: &mut Ui, actions: &mut Vec<Action>) {
    let b = &main.browser;
    ui.spacing_mut().item_spacing.x = 6.0;
    if tool(ui, ph::HOUSE, "My Files", false, None).clicked() && !(b.place == Place::Folder && b.path.is_empty()) {
        actions.push(Action::Crumb(None));
    }
    chevron(ui);
    if b.place != Place::Folder {
        crumb(ui, &b.title(), true);
        return;
    }
    let phone = crate::widgets::mobile(ui.ctx());
    if b.path.is_empty() {
        crumb(ui, "My Files", true);
        return;
    }
    // On a phone the house is My Files; the words would crowd out the folder's own name.
    if !phone && crumb(ui, "My Files", false).clicked() {
        actions.push(Action::Crumb(None));
    }
    let last = b.path.len() - 1;
    let shown = shown_from(b.path.len(), phone);
    if shown > 0 {
        if !phone {
            chevron(ui);
        }
        // The folders in between fold into one menu, so a deep path keeps its end in view.
        let more = crumb(ui, "…", false);
        egui::Popup::menu(&more).show(|ui| {
            ui.set_min_width(170.0);
            for (i, (_, name)) in b.path.iter().enumerate().take(shown) {
                if ui.button(format!("{}  {name}", ph::FOLDER)).clicked() {
                    actions.push(Action::Crumb(Some(i)));
                }
            }
        });
    }
    for (i, (_, name)) in b.path.iter().enumerate().skip(shown) {
        // The house already has its chevron when nothing on a phone sits between them.
        if !(phone && shown == 0 && i == 0) {
            chevron(ui);
        }
        if crumb(ui, name, i == last).clicked() && i != last {
            actions.push(Action::Crumb(Some(i)));
        }
    }
}

/// The first crumb shown in full: the last two folders (one on a phone), the rest in "…".
pub fn shown_from(depth: usize, phone: bool) -> usize {
    let keep = if phone { 1 } else { 2 };
    if depth > keep + 1 { depth - keep } else { 0 }
}

fn sort_menu(ui: &mut Ui, prefs: &Prefs, actions: &mut Vec<Action>) {
    let response = tool(ui, ph::ARROWS_DOWN_UP, "Sort", false, None);
    egui::Popup::menu(&response).show(|ui| {
        ui.set_min_width(180.0);
        ui.label(RichText::new("Sort by").size(11.0).semibold().color(widgets::tokens(ui).label_tertiary));
        for (sort, label) in [
            (SortBy::Name, "Name"),
            (SortBy::Modified, "Date modified"),
            (SortBy::Size, "Size"),
            (SortBy::AccessedAt, "Last opened"),
        ] {
            if ui.radio(prefs.sort == sort, label).clicked() {
                actions.push(Action::Sort(sort));
            }
        }
        ui.separator();
        for (order, label) in [(SortOrder::Asc, "Ascending"), (SortOrder::Desc, "Descending")] {
            if ui.radio(prefs.order == order, label).clicked() {
                actions.push(Action::Order(order));
            }
        }
    });
}

/// What the selection can do, before the view controls.
fn selection_tools(main: &Main, ui: &mut Ui, selection: &[FileItem], actions: &mut Vec<Action>) {
    let t = widgets::tokens(ui);
    let user = &main.user;
    let ids: Vec<String> = selection.iter().map(|i| i.id.clone()).collect();
    if main.browser.place == Place::Trash {
        if user.can(Permission::Trash) {
            if tool(ui, ph::TRASH, "Delete forever", false, Some(t.destructive_text)).clicked() {
                actions.push(Action::DeleteForever(ids.clone()));
            }
            if tool(ui, ph::ARROW_COUNTER_CLOCKWISE, "Restore", false, None).clicked() {
                actions.push(Action::Restore(ids));
            }
        }
    } else {
        // Laid out right to left, so the first button added sits at the far right.
        if user.can(Permission::Delete) && tool(ui, ph::TRASH, "Move to trash", false, None).clicked() {
            actions.push(Action::Trash(selection.to_vec()));
        }
        if user.can(Permission::Edit)
            && selection.len() == 1
            && tool(ui, ph::PENCIL_SIMPLE, "Rename", false, None).clicked()
        {
            actions.push(Action::Rename(selection[0].clone()));
        }
        if user.can(Permission::Download) && tool(ui, ph::DOWNLOAD_SIMPLE, "Download", false, None).clicked() {
            actions.push(Action::Download(selection.to_vec()));
        }
        if user.can(Permission::Edit) {
            let all = selection.iter().all(|i| i.starred);
            let (icon, tip) = if all { (egui_phosphor::fill::STAR, "Unstar") } else { (ph::STAR, "Star") };
            if tool(ui, icon, tip, false, all.then_some(t.warning)).clicked() {
                actions.push(Action::Star(ids.clone(), !all));
            }
        }
        if user.can(Permission::Share) && tool(ui, ph::SHARE_NETWORK, "Share", false, None).clicked() {
            actions.push(Action::Share(selection.to_vec()));
        }
    }
    ui.label(RichText::new(format!("{} selected", selection.len())).size(12.0).medium().color(t.accent));
}

/// The view controls and the place's own buttons (New folder, Paste, Empty trash).
/// Touch has no Ctrl or Shift, so selecting several items is a mode, as in the web app.
fn select_toggle(main: &Main, ui: &mut Ui, actions: &mut Vec<Action>) {
    if widgets::touch_mode(ui.ctx()) && main.browser.place != Place::Trash || main.browser.select_mode {
        let on = main.browser.select_mode;
        if tool(ui, ph::CHECK_SQUARE, if on { "Done selecting" } else { "Select" }, on, None).clicked() {
            actions.push(Action::SelectMode(!on));
        }
    }
}

fn view_tools(main: &Main, ui: &mut Ui, prefs: &Prefs, actions: &mut Vec<Action>) {
    let place = &main.browser.place;
    if *place != Place::Trash && !matches!(place, Place::Search(_)) {
        sort_menu(ui, prefs, actions);
    }
    match place {
        Place::Folder if main.user.can(Permission::Upload) => {
            if tool(ui, ph::FOLDER_PLUS, "New folder", false, None).clicked() {
                actions.push(Action::NewFolder);
            }
        }
        Place::Trash if main.user.can(Permission::Trash) && !main.browser.items.is_empty() => {
            let t = widgets::tokens(ui);
            if tool(ui, ph::BROOM, "Empty trash", false, Some(t.destructive_text)).clicked() {
                actions.push(Action::EmptyTrash);
            }
        }
        _ => {}
    }
    if *place == Place::Folder
        && (main.browser.clip.is_some() || main.browser.system_clip)
        && tool(ui, ph::CLIPBOARD_TEXT, "Paste", false, None).clicked()
    {
        actions.push(Action::Paste);
    }
    select_toggle(main, ui, actions);
    if tool(ui, ph::LIST_BULLETS, "List view", !prefs.grid_view, None).clicked() {
        actions.push(Action::Grid(false));
    }
    if tool(ui, ph::SQUARES_FOUR, "Grid view", prefs.grid_view, None).clicked() {
        actions.push(Action::Grid(true));
    }
}

pub fn show(main: &Main, ui: &mut Ui, prefs: &Prefs, actions: &mut Vec<Action>) {
    let t = widgets::tokens(ui);
    let selection = main.browser.selected_items();
    let phone = crate::widgets::mobile(ui.ctx());
    egui::Frame::new()
        .fill(t.surface)
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(18))
        .inner_margin(egui::Margin::symmetric(if phone { 10 } else { 18 }, 12))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                ui.set_min_height(34.0);
                // A phone shows the place in its header and has the system Back; the room goes to the tools.
                if !phone {
                    history(main, ui, actions);
                }
                // The tools are placed first; the breadcrumbs get the room that is left and truncate.
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.spacing_mut().item_spacing.x = 2.0;
                    // A phone has room for the selection or the view, not both: what was picked wins.
                    if phone && !selection.is_empty() {
                        select_toggle(main, ui, actions);
                        divider(ui);
                        selection_tools(main, ui, &selection, actions);
                        return;
                    }
                    view_tools(main, ui, prefs, actions);
                    if !selection.is_empty() {
                        divider(ui);
                        selection_tools(main, ui, &selection, actions);
                    }
                    ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| crumbs(main, ui, actions));
                });
            });
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn deep_paths_fold_the_middle() {
        assert_eq!(super::shown_from(2, false), 0);
        assert_eq!(super::shown_from(3, false), 0);
        assert_eq!(super::shown_from(5, false), 3);
        assert_eq!(super::shown_from(3, true), 2);
    }
}
