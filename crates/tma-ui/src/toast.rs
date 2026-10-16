//! Short notices in the bottom-right corner that fade out on their own.

use egui::{Align2, Color32, CornerRadius, Frame, Margin, RichText, Stroke};

use crate::icons::ph;
use crate::theme::Tokens;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Success,
    Error,
}

struct Toast {
    text: String,
    level: Level,
    shown_at: f64,
}

#[derive(Default)]
pub struct Toasts {
    items: Vec<Toast>,
    /// Messages added before the first frame, stamped when shown.
    pending: Vec<(String, Level)>,
}

const LIFETIME: f64 = 4.0;

impl Toasts {
    pub fn info(&mut self, text: impl Into<String>) {
        self.pending.push((text.into(), Level::Info));
    }

    pub fn success(&mut self, text: impl Into<String>) {
        self.pending.push((text.into(), Level::Success));
    }

    pub fn error(&mut self, text: impl Into<String>) {
        self.pending.push((text.into(), Level::Error));
    }

    pub fn show(&mut self, ctx: &egui::Context, t: &Tokens) {
        let now = ctx.input(|i| i.time);
        for (text, level) in self.pending.drain(..) {
            self.items.retain(|i| i.text != text);
            self.items.push(Toast { text, level, shown_at: now });
        }
        self.items.retain(|i| now - i.shown_at < LIFETIME);
        if self.items.len() > 4 {
            let excess = self.items.len() - 4;
            self.items.drain(..excess);
        }
        if self.items.is_empty() {
            return;
        }
        let panel = ctx.data(|d| d.get_temp::<f32>(egui::Id::new(crate::transfers::PANEL_HEIGHT))).unwrap_or(0.0);
        let lift = if panel > 0.0 { panel + 10.0 } else { 0.0 };
        egui::Area::new(egui::Id::new("toasts"))
            .anchor(Align2::RIGHT_BOTTOM, [-18.0, -18.0 - lift])
            .order(egui::Order::Tooltip)
            .show(ctx, |ui| {
                ui.set_max_width(360.0);
                for toast in &self.items {
                    let age = now - toast.shown_at;
                    // In over 0.18 s, out over the last 0.3 s.
                    let alpha = (age.min(0.18) / 0.18).min((LIFETIME - age).min(0.3) / 0.3).clamp(0.0, 1.0) as f32;
                    if age < 0.18 {
                        ctx.request_repaint();
                    }
                    let (icon, color) = match toast.level {
                        Level::Info => (ph::INFO, t.accent),
                        Level::Success => (ph::CHECK_CIRCLE, t.positive),
                        Level::Error => (ph::WARNING_CIRCLE, t.destructive),
                    };
                    ui.set_opacity(alpha);
                    Frame::new()
                        .fill(t.surface_raised)
                        .stroke(Stroke::new(1.0, t.separator))
                        .corner_radius(CornerRadius::same(12))
                        .inner_margin(Margin::symmetric(12, 9))
                        .shadow(egui::epaint::Shadow {
                            offset: [0, 4],
                            blur: 16,
                            spread: 0,
                            color: Color32::from_black_alpha(40),
                        })
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(icon).size(16.0).color(color));
                                ui.label(&toast.text);
                            });
                        });
                    ui.add_space(6.0);
                }
            });
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}
