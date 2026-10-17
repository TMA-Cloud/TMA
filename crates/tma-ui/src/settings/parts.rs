//! Building blocks the Settings pages share: figure tiles, status chips,
//! collapsible configuration cards, notes, danger groups and the usage meter.

use egui::{Align2, Color32, CornerRadius, FontId, Frame, Margin, RichText, Sense, Stroke, Vec2};
use tma_core::api::StorageUsage;

use crate::icons::ph;
use crate::theme::{Tokens, Weight};
use crate::widgets;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Success,
    Warning,
    Neutral,
    Info,
    Danger,
}

impl Tone {
    fn color(self, t: &Tokens) -> Color32 {
        match self {
            Tone::Success => t.positive_text,
            Tone::Warning => t.warning_text,
            Tone::Neutral => t.label_secondary,
            Tone::Info => t.accent,
            Tone::Danger => t.destructive_text,
        }
    }

    fn icon(self) -> Option<&'static str> {
        match self {
            Tone::Success => Some(ph::CHECK_CIRCLE),
            Tone::Warning => Some(ph::WARNING),
            Tone::Danger => Some(ph::WARNING_CIRCLE),
            Tone::Neutral | Tone::Info => None,
        }
    }
}

fn tint(color: Color32, alpha: u8) -> Color32 {
    crate::theme::with_alpha(color, alpha)
}

/// A short state label: "Configured", "Up to date", "30 days".
pub fn chip(ui: &mut egui::Ui, tone: Tone, text: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    let color = tone.color(&t);
    Frame::new()
        .fill(tint(color, 28))
        .corner_radius(CornerRadius::same(10))
        .inner_margin(Margin::symmetric(8, 3))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.x = 4.0;
            ui.horizontal(|ui| {
                if let Some(icon) = tone.icon() {
                    ui.label(RichText::new(icon).size(12.0).color(color));
                }
                ui.label(RichText::new(text).size(12.0).semibold().color(color));
            });
        })
        .response
}

/// A read-only figure as a tile; `None` shows a dash while it loads.
pub fn stat(ui: &mut egui::Ui, width: f32, icon: &str, label: &str, value: Option<String>, hint: &str) {
    let t = widgets::tokens(ui);
    Frame::new()
        .stroke(Stroke::new(1.0, t.separator))
        .corner_radius(CornerRadius::same(14))
        .inner_margin(Margin::symmetric(14, 12))
        .show(ui, |ui| {
            ui.set_width(width - 30.0);
            // The tile may sit in a row; its own content stacks.
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 3.0;
                ui.horizontal(|ui| {
                    ui.label(RichText::new(icon).size(14.0).color(t.label_tertiary));
                    ui.label(RichText::new(label).size(12.0).color(t.label_secondary));
                });
                let loading = value.is_none();
                let value = value.unwrap_or_else(|| "—".into());
                let size = if value.starts_with(|c: char| c.is_ascii_digit()) { 22.0 } else { 16.0 };
                let color = if loading { t.label_quaternary } else { t.label };
                ui.label(RichText::new(value).size(size).bold().color(color));
                if !hint.is_empty() {
                    ui.label(RichText::new(hint).size(12.0).color(t.label_tertiary));
                }
            });
        });
}

/// Lay out `n` tiles in one row, or two per row when narrow.
pub fn tile_width(ui: &egui::Ui, n: usize) -> f32 {
    let gap = ui.spacing().item_spacing.x;
    let per_row = if ui.available_width() < 520.0 { 2.min(n) } else { n };
    ((ui.available_width() - gap * (per_row as f32 - 1.0)) / per_row as f32).max(120.0)
}

/// A boxed note in a tone: a warning, or plain context. Inside a section card it
/// is one more row instead of a box within the box.
pub fn note(ui: &mut egui::Ui, tone: Tone, text: &str) {
    let t = widgets::tokens(ui);
    let color = tone.color(&t);
    // Always its own tinted box: drawn as a section row it would add a divider inside a card's form.
    let frame = Frame::new()
        .fill(tint(color, 22))
        .stroke(Stroke::new(1.0, tint(color, 70)))
        .corner_radius(CornerRadius::same(12))
        .inner_margin(Margin::symmetric(12, 10));
    frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal_top(|ui| {
            ui.label(RichText::new(tone.icon().unwrap_or(ph::INFO)).color(color));
            ui.add(egui::Label::new(RichText::new(text).size(13.0).color(t.label)).wrap());
        });
    });
}

/// A section of actions that are hard to undo: its title and card in red.
pub fn danger_group(ui: &mut egui::Ui, title: &str, description: &str, add: impl FnOnce(&mut egui::Ui)) {
    let t = widgets::tokens(ui);
    let card = (tint(t.destructive, 10), tint(t.destructive, 70));
    widgets::grouped(ui, (title, t.destructive_text), description, card, add);
}

/// A list dialog's count line with a Refresh button; true when refresh is clicked.
pub fn count_header(ui: &mut egui::Ui, text: &str, loading: bool) -> bool {
    let mut refresh = false;
    ui.horizontal(|ui| {
        ui.label(widgets::muted(ui, text));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let label = if loading { "Refreshing…" } else { "Refresh" };
            refresh =
                ui.add_enabled(!loading, egui::Button::new(format!("{}  {label}", ph::ARROWS_CLOCKWISE))).clicked();
        });
    });
    refresh
}

/// A collapsible configuration card: the whole header toggles it, and its
/// status chip stays visible while closed. Returns true when the header was clicked.
pub fn config_card(
    ui: &mut egui::Ui,
    icon: &str,
    title: &str,
    description: &str,
    status: Option<(Tone, String)>,
    open: bool,
    body: impl FnOnce(&mut egui::Ui),
) -> bool {
    let t = widgets::tokens(ui);
    let mut clicked = false;
    widgets::row_frame(ui).show(ui, |ui| {
        ui.set_width(ui.available_width());
        let width = ui.available_width();
        let header = ui
            .horizontal(|ui| {
                ui.set_width(width);
                let (badge, _) = ui.allocate_exact_size(Vec2::splat(34.0), Sense::hover());
                ui.painter().rect_filled(badge, 10.0, t.accent_fill);
                ui.painter().text(badge.center(), Align2::CENTER_CENTER, icon, FontId::proportional(17.0), t.accent);
                ui.vertical(|ui| {
                    ui.set_max_width((width - 230.0).max(140.0));
                    ui.spacing_mut().item_spacing.y = 1.0;
                    ui.label(RichText::new(title).size(14.0).semibold().color(t.label));
                    ui.label(RichText::new(description).size(12.0).color(t.label_tertiary));
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let caret = if open { ph::CARET_UP } else { ph::CARET_DOWN };
                    ui.label(RichText::new(caret).size(15.0).color(t.label_tertiary));
                    match &status {
                        Some((tone, text)) => {
                            chip(ui, *tone, text);
                        }
                        None => {
                            ui.spinner();
                        }
                    }
                });
            })
            .response;
        let response = ui.interact(header.rect, ui.scope_id().with(("card", title)), Sense::click());
        if response.hovered() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        clicked = response.clicked() && status.is_some();
        if open {
            ui.add_space(16.0);
            widgets::form(ui, body);
        }
    });
    clicked
}

/// A label and a value that is shown, not edited.
pub fn readonly(ui: &mut egui::Ui, label: &str, value: &str, empty: &str) {
    let t = widgets::tokens(ui);
    let text = if value.is_empty() {
        RichText::new(empty).italics().color(t.label_tertiary)
    } else {
        RichText::new(value).color(t.label)
    };
    widgets::labelled(ui, label, |ui| ui.add(egui::Label::new(text).wrap()));
}

/// A field's small print under it.
pub fn hint(ui: &mut egui::Ui, text: &str) {
    let t = widgets::tokens(ui);
    // Close under the field it explains, however far apart the form spaces its groups.
    ui.add_space(4.0 - ui.spacing().item_spacing.y);
    ui.add(egui::Label::new(RichText::new(text).size(12.0).color(t.label_tertiary)).wrap());
}

/// A password field with an eye inside its right edge to show what was typed,
/// so it lines up with the plain fields around it.
pub fn secret_field(ui: &mut egui::Ui, label: &str, value: &mut String, hint: &str) -> egui::Response {
    let t = widgets::tokens(ui);
    let id = ui.scope_id().with(("show", label));
    let mut shown = ui.data(|d| d.get_temp::<bool>(id)).unwrap_or(false);
    let edit = egui::TextEdit::singleline(value)
        .password(!shown)
        .hint_text(hint)
        .desired_width(f32::INFINITY)
        .margin(Margin { left: 10, right: 34, top: 8, bottom: 8 });
    let response = widgets::labelled(ui, label, |ui| widgets::bordered_field(ui, edit));
    let eye = egui::Rect::from_center_size(response.rect.right_center() - Vec2::new(17.0, 0.0), Vec2::splat(24.0));
    let (icon, tip) = if shown { (ph::EYE_SLASH, "Hide") } else { (ph::EYE, "Show") };
    let button = egui::Button::new(RichText::new(icon).size(15.0).color(t.label_tertiary)).frame(false);
    if ui.put(eye, button).on_hover_text(tip).clicked() {
        shown = !shown;
    }
    ui.data_mut(|d| d.insert_temp(id, shown));
    response
}

/// Two fields side by side when there is room for both, one under the other when not.
pub fn pair(ui: &mut egui::Ui, left: impl FnOnce(&mut egui::Ui), right: impl FnOnce(&mut egui::Ui)) {
    if ui.available_width() < 440.0 {
        left(ui);
        right(ui);
        return;
    }
    ui.columns(2, |cols| {
        left(&mut cols[0]);
        right(&mut cols[1]);
    });
}

/// A group heading inside a form, with room above to set it off from the last field.
pub fn form_heading(ui: &mut egui::Ui, title: &str, note: &str) {
    let t = widgets::tokens(ui);
    // A step more room above than between fields, so the groups read as groups.
    ui.add_space(8.0);
    ui.scope(|ui| {
        ui.spacing_mut().item_spacing.y = 2.0;
        ui.label(RichText::new(title).size(14.0).semibold().color(t.label));
        if !note.is_empty() {
            ui.add(egui::Label::new(RichText::new(note).size(12.0).color(t.label_tertiary)).wrap());
        }
    });
}

/// Usage against the quota: amber once nearly full, red once it effectively is.
pub fn meter(ui: &mut egui::Ui, usage: Option<StorageUsage>) {
    let t = widgets::tokens(ui);
    widgets::card(ui, |ui| {
        ui.set_width(ui.available_width());
        let Some(usage) = usage else {
            ui.label(widgets::muted(ui, "Calculating storage usage…"));
            return;
        };
        let total = usage.total.filter(|t| *t > 0);
        ui.horizontal_wrapped(|ui| {
            ui.label(RichText::new(tma_core::format::storage_size(usage.used)).size(24.0).bold().color(t.label));
            let of = match total {
                Some(total) => format!("of {} used", tma_core::format::storage_size(total)),
                None => "used".into(),
            };
            ui.label(widgets::muted(ui, of));
        });
        let Some(total) = total else {
            ui.label(RichText::new("No storage limit").size(13.0).color(t.label_tertiary));
            return;
        };
        let raw = usage.used as f64 * 100.0 / total as f64;
        let color = if raw >= 95.0 {
            t.destructive
        } else if raw >= 80.0 {
            t.warning
        } else {
            t.accent
        };
        ui.add_space(6.0);
        let (rect, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 8.0), Sense::hover());
        ui.painter().rect_filled(rect, 4.0, t.fill_secondary);
        let fraction = if usage.used > 0 { (raw / 100.0).clamp(0.01, 1.0) } else { 0.0 };
        let mut done = rect;
        done.set_width(rect.width() * fraction as f32);
        ui.painter().rect_filled(done, 4.0, color);
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{}% full", raw.min(100.0).floor())).size(12.0).color(t.label_tertiary));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let free = match usage.free {
                    Some(free) => format!("{} free", tma_core::format::storage_size(free)),
                    None => "Unlimited space remaining".into(),
                };
                ui.label(RichText::new(free).size(12.0).color(t.label_tertiary));
            });
        });
    });
}

/// What a card's form buttons asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormAction {
    Save,
    Cancel,
}

/// Cancel and Save, right-aligned; `busy` shows the save as running.
pub fn form_actions(ui: &mut egui::Ui, busy: bool, save: &str, saving: &str) -> Option<FormAction> {
    let mut action = None;
    widgets::dialog_footer(ui, |ui| {
        if widgets::primary_enabled(ui, !busy, if busy { saving } else { save }).clicked() {
            action = Some(FormAction::Save);
        }
        if ui.add_enabled_ui(!busy, |ui| widgets::secondary(ui, "Cancel")).inner.clicked() {
            action = Some(FormAction::Cancel);
        }
    });
    action
}
