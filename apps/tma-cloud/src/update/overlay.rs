//! While the app updates itself: a card in the middle of the window over a blurred
//! picture of the app, which takes no clicks until the new version opens.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use egui::{Id, LayerId, Order, Rect, RichText, TextureHandle, TextureOptions, pos2};
use tma_client::Progress;
use tma_ui::theme::{self, Tokens, Weight};
use tma_ui::widgets;

/// What the update is doing now; `None` when no update is under way.
static STATUS: Mutex<Option<Status>> = Mutex::new(None);

/// How long to wait for the window's picture before dimming the app without it.
const PICTURE_WAIT: f64 = 0.5;
const CARD_WIDTH: f32 = 440.0;

#[derive(Clone)]
pub struct Status {
    pub version: String,
    pub step: Step,
}

#[derive(Clone)]
pub enum Step {
    Downloading(Arc<Progress>),
    Installing,
}

/// Show `status`, or nothing for `None`; the next frame picks it up.
pub fn set(status: Option<Status>) {
    *STATUS.lock().unwrap_or_else(|e| e.into_inner()) = status;
}

fn current() -> Option<Status> {
    STATUS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The blurred picture behind the card, taken once per update.
#[derive(Default)]
pub struct Overlay {
    /// When the picture was asked for (egui time).
    asked: Option<f64>,
    picture: Arc<Mutex<Option<egui::ColorImage>>>,
    texture: Option<TextureHandle>,
}

impl Overlay {
    pub fn show(&mut self, ctx: &egui::Context) {
        let Some(status) = current() else {
            *self = Self::default();
            return;
        };
        let now = ctx.input(|i| i.time);
        let Some(asked) = self.asked else {
            // Nothing is drawn over the app until its picture is taken, so the picture is clean.
            self.asked = Some(now);
            let (slot, repaint) = (self.picture.clone(), ctx.clone());
            ctx.request_screenshot(move |image| {
                *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(super::blur::blur(&image));
                repaint.request_repaint();
            });
            ctx.request_repaint();
            return;
        };
        if let Some(picture) = self.picture.lock().unwrap_or_else(|e| e.into_inner()).take() {
            self.texture = Some(ctx.load_texture("update-backdrop", picture, TextureOptions::LINEAR));
        }
        if self.texture.is_none() && now - asked < PICTURE_WAIT {
            ctx.request_repaint();
            return;
        }
        let t = widgets::tokens_ctx(ctx);
        backdrop(ctx, self.texture.as_ref(), &t);
        card(ctx, &status, &t);
        ctx.request_repaint_after(Duration::from_millis(100));
    }
}

/// The blurred app, toned towards the canvas colour so the card stands out; without a
/// picture (a window that drew nothing), a plain dim.
fn backdrop(ctx: &egui::Context, texture: Option<&TextureHandle>, t: &Tokens) {
    let rect = ctx.content_rect();
    let painter = ctx.layer_painter(LayerId::new(Order::Foreground, Id::unique("update-overlay-backdrop")));
    if let Some(texture) = texture {
        let uv = Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0));
        painter.image(texture.id(), rect, uv, theme::NO_TINT);
    }
    let tone = if texture.is_some() { 70 } else { 220 };
    painter.rect_filled(rect, 0.0, theme::with_alpha(t.canvas, tone));
}

fn card(ctx: &egui::Context, status: &Status, t: &Tokens) {
    // Not "update-card": the sidebar's update notice uses that id.
    let mut modal = widgets::modal(ctx, "update-overlay-card");
    // Above toasts and the transfers panel, and the blur is the only backdrop.
    modal.area = modal.area.order(Order::Tooltip);
    modal.backdrop_color = theme::with_alpha(t.canvas, 0);
    modal.show(ctx, |ui| {
        ui.set_width(CARD_WIDTH);
        ui.spacing_mut().item_spacing.y = 6.0;
        ui.label(RichText::new("Updating TMA Cloud").size(22.0).semibold().color(t.label));
        ui.label(RichText::new(format!("Version {}", status.version)).size(14.0).color(t.label_secondary));
        ui.add_space(14.0);
        let note = match &status.step {
            Step::Downloading(progress) => {
                let (done, total) = (progress.done.load(Ordering::Relaxed), progress.total.load(Ordering::Relaxed));
                let fraction = if total > 0 { done as f32 / total as f32 } else { 0.0 };
                widgets::progress_bar(ui, fraction, CARD_WIDTH);
                downloaded(done, total)
            }
            Step::Installing => {
                widgets::busy_bar(ui, CARD_WIDTH);
                "Installing. TMA Cloud reopens by itself in a few seconds.".to_string()
            }
        };
        ui.add_space(4.0);
        ui.label(RichText::new(note).size(13.0).color(t.label_tertiary));
    });
}

/// "Downloading 6.2 MB of 18.4 MB", or without the total when the server sent none.
fn downloaded(done: u64, total: u64) -> String {
    let size = |bytes: u64| tma_core::format::file_size(i64::try_from(bytes).unwrap_or(i64::MAX));
    if total > 0 {
        format!("Downloading {} of {}", size(done), size(total))
    } else {
        format!("Downloading {}", size(done))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_much_is_downloaded() {
        assert_eq!(downloaded(0, 0), format!("Downloading {}", tma_core::format::file_size(0)));
        let line = downloaded(1_048_576, 4_194_304);
        assert!(line.starts_with("Downloading ") && line.contains(" of "), "{line}");
    }
}
