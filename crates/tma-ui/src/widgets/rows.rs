//! Settings rows and the sections that group them: a title, a line of context,
//! then the rows in one card, each reflowing by its own width.

use egui::{Color32, CornerRadius, Frame, Margin, RichText, Stroke, Ui};

use super::{ROW_ACTIONS, tokens};
use crate::theme::Weight;

/// The least room a row's title and description get beside its controls before the
/// controls move under them.
const ROW_TEXT_MIN: f32 = 240.0;

/// A settings row, a bordered card: title and description on the left, the control on the right.
pub fn setting_row(ui: &mut Ui, title: &str, description: &str, control: impl FnOnce(&mut Ui)) {
    let t = tokens(ui);
    // The text gets what the controls left on the last frame, so a toggle does not
    // wrap a description that a wide button would have needed the room for.
    let key = egui::Id::unique(("setting-row-control", title, description));
    let control_width = ui.data(|d| d.get_temp::<f32>(key)).unwrap_or(160.0);
    let text = |ui: &mut Ui, centre: bool| {
        ui.spacing_mut().item_spacing.y = 2.0;
        // A title alone sits level with the 30-point controls beside it.
        if centre && description.is_empty() {
            ui.add_space(6.0);
        }
        ui.label(RichText::new(title).size(14.0).medium().color(t.label));
        if !description.is_empty() {
            ui.label(RichText::new(description).size(13.0).color(t.label_tertiary));
        }
    };
    row_frame(ui).show(ui, |ui| {
        let width = ui.available_width();
        // Like a container query: the row reflows by its own width, not the window's.
        // Too narrow for the text beside the controls, the controls go under it.
        if width - control_width - 24.0 < ROW_TEXT_MIN {
            ui.vertical(|ui| {
                text(ui, false);
                ui.add_space(8.0);
                let controls = ui.horizontal(|ui| {
                    ui.style_mut().override_font_id = Some(egui::FontId::proportional(14.0));
                    ui.data_mut(|d| d.insert_temp(egui::Id::unique(ROW_ACTIONS), true));
                    control(ui);
                    ui.data_mut(|d| d.remove::<bool>(egui::Id::unique(ROW_ACTIONS)));
                    ui.min_rect().width()
                });
                if (controls.inner - control_width).abs() > 0.5 {
                    ui.data_mut(|d| d.insert_temp(key, controls.inner));
                }
            });
            return;
        }
        ui.horizontal(|ui| {
            ui.set_width(width);
            ui.vertical(|ui| {
                ui.set_max_width((width - control_width - 24.0).max(ROW_TEXT_MIN));
                text(ui, true);
            });
            let controls = ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.style_mut().override_font_id = Some(egui::FontId::proportional(14.0));
                ui.data_mut(|d| d.insert_temp(egui::Id::unique(ROW_ACTIONS), true));
                control(ui);
                ui.data_mut(|d| d.remove::<bool>(egui::Id::unique(ROW_ACTIONS)));
                ui.min_rect().width()
            });
            let used = controls.inner;
            if (used - control_width).abs() > 0.5 {
                ui.data_mut(|d| d.insert_temp(key, used));
                ui.ctx().request_repaint();
            }
        });
    });
}

/// A group of settings: a title, a line of context, then its rows in one card,
/// divided by hairlines (rows draw their own card only outside a section).
pub fn section(ui: &mut Ui, title: &str, subtitle: &str, add: impl FnOnce(&mut Ui)) {
    let t = tokens(ui);
    grouped(ui, (title, t.label), subtitle, (t.surface, t.separator), add);
}

/// A section with its own title colour and card fill and border: the danger zone
/// is one in red.
pub fn grouped(
    ui: &mut Ui,
    (title, title_color): (&str, Color32),
    subtitle: &str,
    (fill, border): (Color32, Color32),
    add: impl FnOnce(&mut Ui),
) {
    let t = tokens(ui);
    // Sections stand apart from each other, and their titles above the rows' own.
    // A lone card needs no heading of its own: its title already says what it is.
    if title.is_empty() {
        ui.add_space(16.0);
    } else {
        ui.add_space(24.0);
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 3.0;
            ui.label(RichText::new(title).size(16.0).semibold().color(title_color));
            if !subtitle.is_empty() {
                ui.label(RichText::new(subtitle).size(13.0).color(t.label_secondary));
            }
        });
        ui.add_space(10.0);
    }
    let card = Frame::new().fill(fill).stroke(Stroke::new(1.0, border)).corner_radius(CornerRadius::same(12));
    card.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.spacing_mut().item_spacing.y = 0.0;
        ui.data_mut(|d| d.insert_temp(egui::Id::unique(GROUP_ROWS), 0u32));
        add(ui);
        ui.data_mut(|d| d.remove::<u32>(egui::Id::unique(GROUP_ROWS)));
    });
}

/// Whether rows are being drawn inside a section card.
pub fn in_section(ui: &Ui) -> bool {
    ui.data(|d| d.get_temp::<u32>(egui::Id::unique(GROUP_ROWS))).is_some()
}

/// Rows drawn so far in the open section; absent outside one.
const GROUP_ROWS: &str = "tma-settings-group-rows";

/// The frame for one settings row: inside a section, no border of its own and a
/// hairline above every row but the first; outside, a card of its own.
pub fn row_frame(ui: &mut Ui) -> Frame {
    let t = tokens(ui);
    let id = egui::Id::unique(GROUP_ROWS);
    match ui.data(|d| d.get_temp::<u32>(id)) {
        Some(drawn) => {
            if drawn > 0 {
                let rect = ui.available_rect_before_wrap();
                ui.painter().hline(rect.x_range().shrink(16.0), rect.top(), Stroke::new(1.0, t.separator));
            }
            ui.data_mut(|d| d.insert_temp(id, drawn + 1));
            Frame::new().inner_margin(Margin::symmetric(16, 14))
        }
        None => Frame::new()
            .stroke(Stroke::new(1.0, t.separator))
            .corner_radius(CornerRadius::same(12))
            .inner_margin(Margin::symmetric(16, 14)),
    }
}
