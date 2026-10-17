//! New Folder and Rename: one name field, pre-selected the way file managers do,
//! checked as it is typed so a clash or a bad character shows before sending.

use egui::text::{CCursor, CCursorRange};
use egui::{Id, Key, RichText, Ui};
use tma_core::api::FileItem;

use super::{Outcome, dialog_with};
use crate::icons::ph;
use crate::widgets;

/// The name field; true when Enter submits it. While `fresh`, the field takes the
/// focus and then has its first `selected` characters selected, so typing replaces them.
fn field(ui: &mut Ui, id: &str, name: &mut String, fresh: &mut bool, selected: usize, problem: Option<&str>) -> bool {
    let t = widgets::tokens(ui);
    let id = Id::unique(id);
    // Focus first: a field that just gained focus moves its cursor, so the
    // selection is set on the next frame, once the focus has settled.
    if *fresh {
        if ui.memory(|m| m.has_focus(id)) {
            let mut state = egui::text_edit::TextEditState::load(ui.ctx(), id).unwrap_or_default();
            state.cursor.set_char_range(Some(CCursorRange::two(CCursor::new(0), CCursor::new(selected))));
            state.store(ui.ctx(), id);
            *fresh = false;
        } else {
            ui.memory_mut(|m| m.request_focus(id));
        }
        ui.ctx().request_repaint();
    }
    // Read before the field runs: on Enter it gives up its focus at once.
    let enter = ui.memory(|m| m.has_focus(id)) && ui.input(|i| i.key_pressed(Key::Enter));
    let edit = egui::TextEdit::singleline(name)
        .id(id)
        .desired_width(f32::INFINITY)
        .margin(egui::Margin::symmetric(10, 8))
        .font(egui::FontId::proportional(14.0));
    let response = widgets::bordered_field(ui, edit);
    response.request_focus();
    // The line under the field keeps its height, so the dialog does not jump as a problem comes and goes.
    ui.add_space(4.0);
    let (text, color) = match problem {
        Some(problem) => (format!("{}  {problem}", ph::WARNING_CIRCLE), t.destructive_text),
        None => (String::new(), t.label_tertiary),
    };
    let line = egui::Vec2::new(ui.available_width(), 16.0);
    ui.allocate_ui_with_layout(line, egui::Layout::left_to_right(egui::Align::Center), |ui| {
        ui.label(RichText::new(text).size(12.0).color(color));
    });
    enter
}

/// The two buttons; true when the main one is clicked or Enter pressed while it is enabled.
fn footer(ui: &mut Ui, label: &str, ok: bool, enter: bool, outcome: &mut Option<Outcome>) -> bool {
    let mut go = false;
    widgets::dialog_footer(ui, |ui| {
        go = (widgets::primary_enabled(ui, ok, label).clicked() || enter) && ok;
        if widgets::secondary(ui, "Cancel").clicked() {
            *outcome = Some(Outcome::Close);
        }
    });
    go
}

/// Where a new folder goes, for the dialog's subtitle.
pub(super) struct Place<'a> {
    pub name: &'a str,
    /// Names already in that folder, when its listing is open.
    pub taken: &'a [&'a str],
}

pub(super) fn new_folder(
    ctx: &egui::Context,
    name: &mut String,
    parent: &Option<String>,
    fresh: &mut bool,
    place: &Place,
) -> Option<Outcome> {
    let mut outcome = None;
    let subtitle = format!("In {}", place.name);
    let close = dialog_with(ctx, "new-folder", 380.0, "New folder", &subtitle, |ui| {
        let problem = tma_core::names::name_problem(name, place.taken.iter().copied());
        let selected = name.chars().count();
        let enter = field(ui, "new-folder-name", name, fresh, selected, problem);
        let ok = !name.trim().is_empty() && problem.is_none();
        if footer(ui, "Create", ok, enter, &mut outcome) {
            outcome = Some(Outcome::CreateFolder(name.trim().to_string(), parent.clone()));
        }
    });
    if close && outcome.is_none() { Some(Outcome::Close) } else { outcome }
}

pub(super) fn rename(
    ctx: &egui::Context,
    item: &FileItem,
    name: &mut String,
    fresh: &mut bool,
    hide_ext: bool,
    taken: &[&str],
) -> Option<Outcome> {
    let mut outcome = None;
    let close = dialog_with(ctx, "rename", 400.0, "Rename", &item.name, |ui| {
        let full = if hide_ext && !item.is_folder() {
            tma_core::names::full_name_for_rename(name.trim(), &item.name)
        } else {
            name.trim().to_string()
        };
        let unchanged = full == item.name;
        // Only the item itself may keep its name; a change of case alone is a rename too.
        let others = taken.iter().copied().filter(|n| *n != item.name);
        let problem = if unchanged { None } else { tma_core::names::name_problem(&full, others) };
        // As in Explorer and Finder, the extension stays out of the selection.
        let selected =
            if item.is_folder() { name.chars().count() } else { tma_core::names::split_ext(name).0.chars().count() };
        let enter = field(ui, "rename-name", name, fresh, selected, problem);
        let ok = !name.trim().is_empty() && problem.is_none();
        if footer(ui, "Rename", ok, enter, &mut outcome) {
            outcome = Some(if unchanged { Outcome::Close } else { Outcome::Rename(item.id.clone(), full) });
        }
    });
    if close && outcome.is_none() { Some(Outcome::Close) } else { outcome }
}
