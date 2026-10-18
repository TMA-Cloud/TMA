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
const FADE_IN: f64 = 0.18;
const FADE_OUT: f64 = 0.28;
const MAX_WIDTH: f32 = 300.0;

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
            // The same notice again (a double-click, repeated clicks) stays as it is, only
            // living a little longer, instead of fading in again or stacking up.
            match self.items.iter_mut().find(|i| i.text == text) {
                Some(shown) => shown.shown_at = shown.shown_at.max(now - FADE_IN),
                None => self.items.push(Toast { text, level, shown_at: now }),
            }
        }
        self.items.retain(|i| now - i.shown_at < LIFETIME);
        if self.items.len() > 4 {
            let excess = self.items.len() - 4;
            self.items.drain(..excess);
        }
        if self.items.is_empty() {
            return;
        }
        let panel = ctx.data(|d| d.get_temp::<f32>(egui::Id::unique(crate::transfers::PANEL_HEIGHT))).unwrap_or(0.0);
        let lift = if panel > 0.0 { panel + 10.0 } else { 0.0 };
        egui::Area::new(egui::Id::unique("toasts"))
            .anchor(Align2::RIGHT_BOTTOM, [-18.0, -18.0 - lift])
            .order(egui::Order::Tooltip)
            .show(ctx, |ui| {
                // Compact: long notices wrap onto a second line instead of stretching across the window.
                ui.set_max_width(MAX_WIDTH);
                for toast in &self.items {
                    let age = now - toast.shown_at;
                    let (alpha, rise) = presence(age);
                    // Every frame of a fade is drawn; the idle repaint below is too coarse for it.
                    if age < FADE_IN || age > LIFETIME - FADE_OUT {
                        ctx.request_repaint();
                    }
                    let (icon, color) = match toast.level {
                        Level::Info => (ph::INFO, t.accent),
                        Level::Success => (ph::CHECK_CIRCLE, t.positive),
                        Level::Error => (ph::WARNING_CIRCLE, t.destructive),
                    };
                    // Scoped, since opacity multiplies: a toast must not inherit the fade of the one above.
                    ui.scope(|ui| {
                        ui.set_opacity(alpha);
                        ui.add_space(rise);
                        Frame::new()
                            .fill(t.surface_raised)
                            .stroke(Stroke::new(1.0, t.separator))
                            .corner_radius(CornerRadius::same(12))
                            .inner_margin(Margin::symmetric(11, 8))
                            .shadow(egui::epaint::Shadow {
                                offset: [0, 4],
                                blur: 16,
                                spread: 0,
                                color: Color32::from_black_alpha(40),
                            })
                            .show(ui, |ui| {
                                ui.set_max_width(MAX_WIDTH - 24.0);
                                ui.horizontal_top(|ui| {
                                    ui.spacing_mut().item_spacing.x = 8.0;
                                    ui.label(RichText::new(icon).size(15.0).color(color));
                                    ui.add(egui::Label::new(RichText::new(&toast.text).size(13.0)).wrap());
                                });
                            });
                    });
                    ui.add_space(6.0);
                }
            });
        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

/// How visible a toast of this age is (0 to 1), and how far it sits below its
/// place, in points: it rises in and sinks out with an ease-out.
fn presence(age: f64) -> (f32, f32) {
    let fade_in = (age / FADE_IN).clamp(0.0, 1.0) as f32;
    let fade_out = ((LIFETIME - age) / FADE_OUT).clamp(0.0, 1.0) as f32;
    let shown = egui::emath::easing::cubic_out(fade_in.min(fade_out));
    (shown, (1.0 - shown) * 6.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_fade_in_hold_and_fade_out() {
        assert_eq!(presence(0.0), (0.0, 6.0));
        assert_eq!(presence(LIFETIME / 2.0), (1.0, 0.0));
        let late = presence(LIFETIME - FADE_OUT / 2.0).0;
        assert!(late > 0.0 && late < 1.0);
        assert_eq!(presence(LIFETIME).0, 0.0);
    }
}
