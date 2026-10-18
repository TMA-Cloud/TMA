//! The share dialog: choosing how long a link lasts, then the link itself,
//! how long it has left, and copying it.

use egui::{Align2, Color32, RichText, Vec2};
use tma_core::api::FileItem;

use super::{Outcome, Share};
use crate::icons::ph;
use crate::theme::Weight;
use crate::widgets;

pub(super) fn share_body(ui: &mut egui::Ui, share: &mut Share, outcome: &mut Option<Outcome>) {
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
    if !share.loaded {
        ui.add_space(8.0);
        ui.vertical_centered(|ui| ui.spinner());
        ui.add_space(8.0);
        return;
    }
    let now = chrono::Utc::now();
    let item = share.items.first();
    status(ui, &expiry_text(item, share.expiry, now));
    ui.add_space(12.0);
    let many = share.items.len() > 1;
    for item in &share.items {
        let Some(link) = share.links.get(&item.id) else { continue };
        if many {
            ui.add(egui::Label::new(RichText::new(&item.name).size(12.0).color(t.label_secondary)).truncate());
            ui.add_space(2.0);
        }
        if link_row(ui, &item.id, link) {
            *outcome = Some(Outcome::Copied);
        }
        ui.add_space(8.0);
    }
    ui.add_space(4.0);
    // Stopping stands apart from Done, at the other end, so it is never hit by mistake.
    let size = Vec2::new(ui.available_width(), 32.0);
    ui.allocate_ui_with_layout(size, egui::Layout::left_to_right(egui::Align::Center), |ui| {
        let stop = RichText::new(format!("{}  Stop sharing", ph::LINK_BREAK)).color(t.destructive_text);
        if ui.add_enabled(!share.busy, egui::Button::new(stop).frame(false)).clicked() {
            share.busy = true;
            *outcome = Some(Outcome::ShareSet(ids.clone(), false, "never"));
        }
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if widgets::primary(ui, "Done").clicked() {
                *outcome = Some(Outcome::Close);
            }
        });
    });
}

/// "Anyone with the link can open it · 6 days, 3 hours remaining".
fn status(ui: &mut egui::Ui, expiry: &str) {
    let t = widgets::tokens(ui);
    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        ui.label(RichText::new(ph::GLOBE_SIMPLE).size(14.0).color(t.positive_text));
        ui.label(RichText::new("Anyone with the link can open it").size(13.0).color(t.label));
        ui.label(RichText::new(format!("·  {expiry}")).size(13.0).color(t.label_tertiary));
    });
}

/// How long the link lasts: from the item when it was already shared, else
/// from the expiry just chosen.
fn expiry_text(item: Option<&FileItem>, chosen: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    match (item, chosen) {
        (Some(item), _) if item.shared => tma_core::format::share_remaining(item.expires_at, now),
        (_, "7d") => "7 days remaining".into(),
        (_, "30d") => "30 days remaining".into(),
        _ => "Never expires".into(),
    }
}

/// The link in a bordered field with Copy at its end, which turns into a
/// green "Copied" for a moment; true when clicked.
fn link_row(ui: &mut egui::Ui, id: &str, link: &str) -> bool {
    let t = widgets::tokens(ui);
    let key = egui::Id::unique(("share-copied", id));
    let now = ui.input(|i| i.time);
    let copied = ui.data(|d| d.get_temp::<f64>(key)).is_some_and(|at| now - at < COPIED_FOR);
    if copied {
        ui.ctx().request_repaint_after(std::time::Duration::from_millis(100));
    }
    let shown = widgets::ease(ui, key.with("shown"), copied, widgets::SNAP);
    let mut clicked = false;
    egui::Frame::new()
        .fill(t.fill_quaternary)
        .stroke(egui::Stroke::new(1.0, t.separator_strong))
        .corner_radius(egui::CornerRadius::same(12))
        .inner_margin(egui::Margin { left: 12, right: 4, top: 4, bottom: 4 })
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 8.0;
                ui.label(RichText::new(ph::LINK).size(14.0).color(t.label_tertiary));
                let text_width = (ui.available_width() - BUTTON.x - 8.0).max(40.0);
                ui.allocate_ui(Vec2::new(text_width, BUTTON.y), |ui| {
                    ui.set_width(text_width);
                    ui.add(egui::Label::new(RichText::new(link).size(13.0).color(t.label)).truncate().selectable(true));
                });
                let (icon, label) = if copied { (ph::CHECK, "Copied") } else { (ph::COPY, "Copy") };
                let text = RichText::new(format!("{icon}  {label}")).color(t.on_accent).semibold();
                let fill = crate::theme::mix(t.accent, t.positive, shown);
                let button =
                    egui::Button::new(text).fill(fill).corner_radius(egui::CornerRadius::same(9)).min_size(BUTTON);
                if ui.add(button).on_hover_text("Copy link").clicked() {
                    ui.ctx().copy_text(link.to_string());
                    ui.data_mut(|d| d.insert_temp(key, now));
                    clicked = true;
                }
            });
        });
    clicked
}

/// How long Copy says "Copied".
const COPIED_FOR: f64 = 1.6;
const BUTTON: Vec2 = Vec2::new(92.0, 30.0);

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
