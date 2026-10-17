//! The image viewer: one image at a time over the app, with zoom and pan.

use std::collections::HashMap;

use egui::{Align2, Color32, Key, Vec2};
use tma_core::api::FileItem;

use super::Outcome;
use crate::icons::ph;

pub struct Viewer {
    pub items: Vec<FileItem>,
    pub index: usize,
    pub(super) textures: HashMap<String, egui::TextureHandle>,
    pub(super) failed: HashMap<String, String>,
    pub(super) loading: Option<String>,
    /// 1 shows the whole image; more magnifies it.
    zoom: f32,
    /// How far the image centre sits from the stage centre, in points.
    pan: Vec2,
    /// The image the zoom belongs to; another image starts fitted again.
    zoomed: usize,
    /// How far a drag on a fitted image has gone sideways; far enough turns the page.
    swipe: f32,
}

const MAX_ZOOM: f32 = 8.0;
/// A sideways drag this long moves to the next or previous image.
const SWIPE: f32 = 60.0;
/// A double-click zooms to this, or back to fitted.
const CLOSE_UP: f32 = 2.5;

impl Viewer {
    pub fn new(items: Vec<FileItem>, index: usize) -> Self {
        Self {
            items,
            index,
            textures: HashMap::new(),
            failed: HashMap::new(),
            loading: None,
            zoom: 1.0,
            pan: Vec2::ZERO,
            zoomed: index,
            swipe: 0.0,
        }
    }
}

/// Zoom by `factor`, keeping the point at `focus` (from the stage centre) under the pointer.
pub fn zoom_at(zoom: f32, pan: Vec2, factor: f32, focus: Vec2) -> (f32, Vec2) {
    let next = (zoom * factor).clamp(1.0, MAX_ZOOM);
    let k = next / zoom;
    (next, focus - (focus - pan) * k)
}

/// Keep a magnified image covering the stage: no panning past its edges.
pub fn clamp_pan(pan: Vec2, image: Vec2, stage: Vec2) -> Vec2 {
    let room = ((image - stage) / 2.0).max(Vec2::ZERO);
    Vec2::new(pan.x.clamp(-room.x, room.x), pan.y.clamp(-room.y, room.y))
}

fn round_button(ui: &mut egui::Ui, pos: egui::Pos2, icon: &str, id: &str) -> bool {
    let r = egui::Rect::from_center_size(pos, Vec2::splat(36.0));
    let resp = ui.interact(r, egui::Id::unique(("viewer-btn", id)), egui::Sense::click());
    let t = crate::widgets::tokens(ui);
    if resp.hovered() {
        ui.painter().circle_filled(r.center(), 18.0, crate::theme::with_alpha(t.on_media, 30));
    }
    ui.painter().text(r.center(), Align2::CENTER_CENTER, icon, egui::FontId::proportional(20.0), t.on_media);
    resp.clicked()
}

pub(super) fn viewer_overlay(
    ctx: &egui::Context,
    t: &crate::theme::Tokens,
    viewer: &mut Viewer,
    outcome: &mut Option<Outcome>,
) {
    let Some(item) = viewer.items.get(viewer.index).cloned() else {
        *outcome = Some(Outcome::Close);
        return;
    };
    if !viewer.textures.contains_key(&item.id)
        && !viewer.failed.contains_key(&item.id)
        && viewer.loading.as_deref() != Some(item.id.as_str())
    {
        viewer.loading = Some(item.id.clone());
        *outcome = Some(Outcome::LoadImage(item.id.clone()));
    }
    let screen = ctx.content_rect();
    egui::Area::new(egui::Id::unique("viewer")).order(egui::Order::Foreground).fixed_pos(screen.min).show(ctx, |ui| {
        let (rect, response) = ui.allocate_exact_size(screen.size(), egui::Sense::click());
        ui.painter().rect_filled(rect, 0.0, Color32::from_black_alpha(235));
        let _ = response;
        let bar = egui::Rect::from_min_size(rect.min, Vec2::new(rect.width(), 52.0));
        ui.painter().text(
            bar.left_center() + Vec2::new(20.0, 0.0),
            Align2::LEFT_CENTER,
            &item.name,
            egui::FontId::proportional(15.0),
            t.on_media,
        );
        ui.painter().text(
            bar.left_center() + Vec2::new(20.0, 18.0),
            Align2::LEFT_CENTER,
            format!("{} of {}", viewer.index + 1, viewer.items.len()),
            egui::FontId::proportional(11.0),
            Color32::from_white_alpha(150),
        );
        if round_button(ui, bar.right_center() - Vec2::new(28.0, 0.0), ph::X, "close") {
            *outcome = Some(Outcome::Close);
        }
        if round_button(ui, bar.right_center() - Vec2::new(72.0, 0.0), ph::DOWNLOAD_SIMPLE, "download") {
            *outcome = Some(Outcome::Download(item.clone()));
        }
        if round_button(ui, bar.right_center() - Vec2::new(116.0, 0.0), ph::MAGNIFYING_GLASS_PLUS, "zoom-in") {
            (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, 1.25, Vec2::ZERO);
        }
        if round_button(ui, bar.right_center() - Vec2::new(160.0, 0.0), ph::MAGNIFYING_GLASS_MINUS, "zoom-out") {
            (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, 0.8, Vec2::ZERO);
        }
        // Phones keep the whole width for the image; the arrows sit over it.
        let side = if rect.width() < 600.0 { 8.0 } else { 70.0 };
        let stage = egui::Rect::from_min_max(rect.min + Vec2::new(side, 60.0), rect.max - Vec2::new(side, 24.0));
        let mut step = 0i32;
        if viewer.zoomed != viewer.index {
            (viewer.zoom, viewer.pan, viewer.zoomed) = (1.0, Vec2::ZERO, viewer.index);
        }
        if let Some(texture) = viewer.textures.get(&item.id) {
            let size = texture.size_vec2();
            let fit = (stage.width() / size.x).min(stage.height() / size.y).min(1.0);
            let input = ui.interact(stage, egui::Id::unique("viewer-stage"), egui::Sense::click_and_drag());
            let focus = input.hover_pos().map(|p| p - stage.center()).unwrap_or(Vec2::ZERO);
            let scroll = ui.input(|i| i.smooth_scroll_delta.y + i.zoom_delta().ln() * 400.0);
            if input.hovered() && scroll != 0.0 {
                (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, (scroll * 0.0025).exp(), focus);
            }
            if input.double_clicked() {
                let factor = if viewer.zoom > 1.0 { 1.0 / viewer.zoom } else { CLOSE_UP };
                (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, factor, focus);
            }
            if viewer.zoom > 1.0 && input.dragged() {
                viewer.pan += input.drag_delta();
            } else if input.dragged() {
                viewer.swipe += input.drag_delta().x;
            }
            if input.drag_stopped() {
                if viewer.swipe.abs() > SWIPE {
                    step = if viewer.swipe < 0.0 { 1 } else { -1 };
                }
                viewer.swipe = 0.0;
            }
            viewer.pan = clamp_pan(viewer.pan, size * fit * viewer.zoom, stage.size());
            let icon = if input.dragged() && viewer.zoom > 1.0 {
                egui::CursorIcon::Grabbing
            } else if viewer.zoom > 1.0 {
                egui::CursorIcon::Grab
            } else {
                egui::CursorIcon::ZoomIn
            };
            if input.hovered() {
                ui.ctx().set_cursor_icon(icon);
            }
            let shown = egui::Rect::from_center_size(stage.center() + viewer.pan, size * fit * viewer.zoom);
            let painter = ui.painter().with_clip_rect(stage);
            painter.image(
                texture.id(),
                shown,
                egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                crate::theme::NO_TINT,
            );
        } else if let Some(err) = viewer.failed.get(&item.id) {
            ui.painter().text(
                stage.center(),
                Align2::CENTER_CENTER,
                err,
                egui::FontId::proportional(14.0),
                Color32::from_white_alpha(200),
            );
        } else {
            ui.put(
                egui::Rect::from_center_size(stage.center(), Vec2::splat(32.0)),
                egui::Spinner::new().size(32.0).color(t.on_media),
            );
        }
        let many = viewer.items.len() > 1;
        if many && step != 0 {
            let n = viewer.items.len() as i32;
            viewer.index = (viewer.index as i32 + step).rem_euclid(n) as usize;
        }
        if many && round_button(ui, egui::pos2(rect.left() + 34.0, rect.center().y), ph::CARET_LEFT, "prev") {
            viewer.index = (viewer.index + viewer.items.len() - 1) % viewer.items.len();
        }
        if many && round_button(ui, egui::pos2(rect.right() - 34.0, rect.center().y), ph::CARET_RIGHT, "next") {
            viewer.index = (viewer.index + 1) % viewer.items.len();
        }
    });
    ctx.input(|i| {
        if i.key_pressed(Key::Escape) {
            *outcome = Some(Outcome::Close);
        }
        if i.key_pressed(Key::Plus) || i.key_pressed(Key::Equals) {
            (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, 1.25, Vec2::ZERO);
        }
        if i.key_pressed(Key::Minus) {
            (viewer.zoom, viewer.pan) = zoom_at(viewer.zoom, viewer.pan, 0.8, Vec2::ZERO);
        }
        if i.key_pressed(Key::Num0) {
            (viewer.zoom, viewer.pan) = (1.0, Vec2::ZERO);
        }
        if viewer.items.len() > 1 && i.key_pressed(Key::ArrowRight) {
            viewer.index = (viewer.index + 1) % viewer.items.len();
        }
        if viewer.items.len() > 1 && i.key_pressed(Key::ArrowLeft) {
            viewer.index = (viewer.index + viewer.items.len() - 1) % viewer.items.len();
        }
    });
    let _ = t;
}

/// Decode an image off the frame (any format the `image` crate reads).
pub(super) fn decode(bytes: &[u8]) -> Result<egui::ColorImage, String> {
    let image = image::load_from_memory(bytes).map_err(|e| format!("Cannot show this image: {e}"))?;
    // Very large photos are scaled down; the screen cannot show more pixels anyway.
    let image = if image.width() > 4096 || image.height() > 4096 { image.thumbnail(4096, 4096) } else { image };
    let rgba = image.to_rgba8();
    Ok(egui::ColorImage::from_rgba_unmultiplied([rgba.width() as usize, rgba.height() as usize], rgba.as_raw()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zoom_keeps_the_pointed_spot_still() {
        // Zooming at the centre leaves an unpanned image centred.
        assert_eq!(zoom_at(1.0, Vec2::ZERO, 2.0, Vec2::ZERO), (2.0, Vec2::ZERO));
        // Zooming at a point right of centre moves the image left, so that point stays put.
        let (zoom, pan) = zoom_at(1.0, Vec2::ZERO, 2.0, Vec2::new(100.0, 0.0));
        assert_eq!(zoom, 2.0);
        assert_eq!(pan, Vec2::new(-100.0, 0.0));
        // Never smaller than fitted, never past the maximum.
        assert_eq!(zoom_at(1.0, Vec2::ZERO, 0.5, Vec2::ZERO).0, 1.0);
        assert_eq!(zoom_at(6.0, Vec2::ZERO, 4.0, Vec2::ZERO).0, MAX_ZOOM);
    }

    #[test]
    fn pan_stops_at_the_edges() {
        let stage = Vec2::new(800.0, 600.0);
        // A fitted image cannot move.
        assert_eq!(clamp_pan(Vec2::new(50.0, 50.0), Vec2::new(800.0, 400.0), stage), Vec2::ZERO);
        // A magnified one moves until its edge meets the stage's.
        assert_eq!(clamp_pan(Vec2::new(900.0, 10.0), Vec2::new(1600.0, 1200.0), stage), Vec2::new(400.0, 10.0));
    }
}
