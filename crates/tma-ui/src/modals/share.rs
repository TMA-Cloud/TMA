//! The share dialog: the link, its expiry and copying it.

use egui::{Align2, Color32, RichText, Vec2};

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
