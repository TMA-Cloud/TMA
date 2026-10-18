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
    // Nothing here may paint over the tools, whatever the names measure.
    ui.set_clip_rect(ui.max_rect().intersect(ui.clip_rect()));
    ui.spacing_mut().item_spacing.x = 6.0;
    if tool(ui, ph::HOUSE, "My Files", false, None).clicked() && !(b.place == Place::Folder && b.path.is_empty()) {
        actions.push(Action::Crumb(None));
    }
    chevron(ui);
    if b.place != Place::Folder {
        crumb(ui, &b.title(), true);
        return;
    }
    if b.path.is_empty() {
        crumb(ui, "My Files", true);
        return;
    }
    let widths = measure(ui, &b.path);
    // On a phone the house is My Files; the words would crowd out the folder's own name.
    let phone = crate::widgets::mobile(ui.ctx());
    let fit = fit(&widths, ui.available_width(), !phone);
    let mut first = true;
    let mut gap = |ui: &mut Ui| {
        if !std::mem::take(&mut first) {
            chevron(ui);
        }
    };
    if fit.root {
        gap(ui);
        if crumb(ui, "My Files", false).clicked() {
            actions.push(Action::Crumb(None));
        }
    }
    if fit.more {
        gap(ui);
        // The folders in between fold into one menu, so a deep path keeps its end in view.
        let more = crumb(ui, "…", false);
        egui::Popup::menu(&more).show(|ui| {
            ui.set_min_width(170.0);
            for (i, (_, name)) in b.path.iter().enumerate().take(fit.first) {
                if ui.button(format!("{}  {name}", ph::FOLDER)).clicked() {
                    actions.push(Action::Crumb(Some(i)));
                }
            }
        });
    }
    let last = b.path.len() - 1;
    for (i, (_, name)) in b.path.iter().enumerate().skip(fit.first) {
        gap(ui);
        if crumb(ui, name, i == last).clicked() && i != last {
            actions.push(Action::Crumb(Some(i)));
        }
    }
}

/// What the crumbs after the house need, in points, spacing included.
#[derive(Debug, Clone, PartialEq)]
pub struct CrumbWidths {
    pub root: f32,
    pub more: f32,
    pub chevron: f32,
    pub names: Vec<f32>,
}

fn measure(ui: &Ui, path: &[(String, String)]) -> CrumbWidths {
    let t = widgets::tokens(ui);
    let gap = ui.spacing().item_spacing.x;
    let width = |text: &str, bold: bool| {
        let font = if bold { FontId::new(13.0, crate::theme::semibold()) } else { FontId::proportional(13.0) };
        ui.painter().layout_no_wrap(text.to_string(), font, t.label).size().x + gap
    };
    let last = path.len().saturating_sub(1);
    CrumbWidths {
        root: width("My Files", false),
        more: width("…", false),
        chevron: ui.painter().layout_no_wrap(ph::CARET_RIGHT.into(), FontId::proportional(12.0), t.label).size().x
            + gap,
        names: path.iter().enumerate().map(|(i, (_, name))| width(name, i == last)).collect(),
    }
}

/// Which crumbs to draw: folders from `first` on in full, those before it in "…".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fit {
    pub root: bool,
    pub first: usize,
    /// The "…" menu for the folders before `first`; left out when even it does not
    /// fit, since the open folder's name matters more (Back and Alt+Up still go up).
    pub more: bool,
}

/// As many of the deepest folders as fit in `room`, with "My Files" ahead of them
/// while it fits too; the open folder always shows, truncated when even it alone is too wide.
pub fn fit(w: &CrumbWidths, room: f32, with_root: bool) -> Fit {
    let n = w.names.len();
    for root in [with_root, false] {
        // Walk up from the open folder, adding each one while the row still fits.
        let mut used = if root { w.root } else { 0.0 };
        let mut first = n;
        while first > 0 {
            let next = used + w.names[first - 1] + if used > 0.0 { w.chevron } else { 0.0 };
            // Folding what is left costs a chevron and the "…".
            let fold = if first - 1 > 0 { w.chevron + w.more } else { 0.0 };
            if next + fold > room && first < n {
                break;
            }
            used = next;
            first -= 1;
        }
        let fits = used + if first > 0 { w.chevron + w.more } else { 0.0 } <= room;
        if fits || !root {
            return Fit { root, first: first.min(n.saturating_sub(1)), more: first > 0 && fits };
        }
    }
    Fit { root: false, first: n.saturating_sub(1), more: false }
}

const SORTS: [(SortBy, &str, &str); 4] = [
    (SortBy::Name, ph::TEXT_AA, "Name"),
    (SortBy::Modified, ph::CALENDAR_BLANK, "Date modified"),
    (SortBy::Size, ph::RULER, "Size"),
    (SortBy::AccessedAt, ph::CLOCK, "Last opened"),
];

/// The two directions in the words of the sort, ascending first: "A to Z", "Oldest first".
pub fn order_labels(sort: SortBy) -> (&'static str, &'static str) {
    match sort {
        SortBy::Name => ("A to Z", "Z to A"),
        SortBy::Size => ("Smallest first", "Largest first"),
        SortBy::Modified | SortBy::AccessedAt | SortBy::DeletedAt => ("Oldest first", "Newest first"),
    }
}

/// "Name, A to Z": the sort in force, for the button's tooltip.
pub fn sort_summary(sort: SortBy, order: SortOrder) -> String {
    let name = SORTS.iter().find(|s| s.0 == sort).map_or("Name", |s| s.2);
    let (asc, desc) = order_labels(sort);
    format!("{name}, {}", if order == SortOrder::Asc { asc } else { desc })
}

fn sort_menu(ui: &mut Ui, prefs: &Prefs, actions: &mut Vec<Action>) {
    let tip = format!("Sort: {}", sort_summary(prefs.sort, prefs.order));
    let response = tool(ui, ph::ARROWS_DOWN_UP, &tip, false, None);
    egui::Popup::menu(&response).show(|ui| {
        ui.set_min_width(200.0);
        ui.set_max_width(220.0);
        ui.spacing_mut().item_spacing.y = 1.0;
        super::menu::heading(ui, "Sort by");
        for (sort, icon, label) in SORTS {
            if super::menu::choice(ui, icon, label, prefs.sort == sort) && prefs.sort != sort {
                actions.push(Action::Sort(sort));
            }
        }
        ui.separator();
        super::menu::heading(ui, "Order");
        let (asc, desc) = order_labels(prefs.sort);
        for (order, icon, label) in
            [(SortOrder::Asc, ph::SORT_ASCENDING, asc), (SortOrder::Desc, ph::SORT_DESCENDING, desc)]
        {
            if super::menu::choice(ui, icon, label, prefs.order == order) && prefs.order != order {
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
        if user.can(Permission::Purge)
            && tool(ui, ph::TRASH, "Delete forever", false, Some(t.destructive_text)).clicked()
        {
            actions.push(Action::DeleteForever(ids.clone()));
        }
        if user.can(Permission::Restore) && tool(ui, ph::ARROW_COUNTER_CLOCKWISE, "Restore", false, None).clicked() {
            actions.push(Action::Restore(ids));
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
    // The count gives way first when the bar is narrow, so the open folder keeps its name.
    if ui.available_width() > 240.0 {
        ui.label(RichText::new(format!("{} selected", selection.len())).size(12.0).medium().color(t.accent));
    }
}

/// The view controls and the place's own buttons (New folder, Empty trash); Paste is
/// in the right-click menu and on Ctrl+V, where file managers keep it.
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
        Place::Trash if main.user.can(Permission::Purge) && !main.browser.items.is_empty() => {
            let t = widgets::tokens(ui);
            if tool(ui, ph::BROOM, "Empty trash", false, Some(t.destructive_text)).clicked() {
                actions.push(Action::EmptyTrash);
            }
        }
        _ => {}
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
    use super::{CrumbWidths, Fit, fit};

    fn widths(names: &[f32]) -> CrumbWidths {
        CrumbWidths { root: 60.0, more: 20.0, chevron: 16.0, names: names.to_vec() }
    }

    #[test]
    fn short_paths_show_everything() {
        assert_eq!(fit(&widths(&[50.0, 50.0]), 500.0, true), Fit { root: true, first: 0, more: false });
    }

    #[test]
    fn deep_paths_fold_from_the_top() {
        // My Files 60 + … 36 + three folders of 66 each = 294; a fourth would not fit.
        let w = widths(&[50.0, 50.0, 50.0, 50.0, 50.0]);
        assert_eq!(fit(&w, 300.0, true), Fit { root: true, first: 2, more: true });
        // Too narrow for My Files: the open folder and the "…" alone.
        assert_eq!(fit(&w, 120.0, true), Fit { root: false, first: 4, more: true });
    }

    #[test]
    fn the_open_folder_always_shows() {
        let w = widths(&[50.0, 400.0]);
        assert_eq!(fit(&w, 100.0, true), Fit { root: false, first: 1, more: false });
        assert_eq!(fit(&widths(&[400.0]), 100.0, true), Fit { root: false, first: 0, more: false });
    }

    #[test]
    fn orders_use_the_sort_words() {
        use tma_core::api::{SortBy, SortOrder};
        assert_eq!(super::sort_summary(SortBy::Name, SortOrder::Asc), "Name, A to Z");
        assert_eq!(super::sort_summary(SortBy::Modified, SortOrder::Desc), "Date modified, Newest first");
        assert_eq!(super::order_labels(SortBy::Size), ("Smallest first", "Largest first"));
    }

    #[test]
    fn phones_leave_out_my_files() {
        assert_eq!(fit(&widths(&[50.0, 50.0]), 500.0, false), Fit { root: false, first: 0, more: false });
    }
}
