//! TMA Cloud's own pointers in the desktop app. egui only names system
//! cursors, so the artwork from `tma_ui::cursors` is drawn at the screen's
//! scale and handed to the system: Win32 cursors on Windows, Render cursors
//! on X11 and NSCursor on macOS. Wayland can only name system shapes, so it
//! keeps the system's pointers.

use std::collections::HashMap;

use egui::CursorIcon;
use resvg::tiny_skia::{Pixmap, Transform};
use tma_ui::cursors::{SIZE, Shape};

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod native;
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[path = "none.rs"]
mod native;
#[cfg(windows)]
#[path = "windows.rs"]
mod native;
#[cfg(target_os = "linux")]
#[path = "x11.rs"]
mod native;

/// One shape drawn at `px` × `px`, in straight (not premultiplied) RGBA.
pub struct Image {
    pub px: u32,
    pub hotspot: (u32, u32),
    pub rgba: Vec<u8>,
}

type Key = (&'static str, bool, u32);

#[derive(Default)]
pub struct Cursors {
    tried: bool,
    native: Option<native::Native>,
    made: HashMap<Key, Option<native::Cursor>>,
}

impl Cursors {
    /// Run after each frame: swap the cursor egui asked for for the matching artwork.
    pub fn apply(&mut self, ctx: &egui::Context, frame: &eframe::Frame, dark: bool) {
        if !self.tried {
            self.tried = true;
            self.native = native::Native::new(frame);
        }
        let Some(native) = self.native.as_mut() else { return };
        let icon = ctx.output(|o| o.cursor_icon);
        let scale = ctx.input(|i| i.viewport().native_pixels_per_point).unwrap_or(1.0);
        let wanted = tma_ui::cursors::for_icon(icon).and_then(|shape| {
            let px = pixels(scale);
            self.made
                .entry((shape.name, dark, px))
                .or_insert_with(|| render(shape, dark, px).and_then(|image| native.make(&image)))
                .as_ref()
        });
        if wanted.is_some() {
            // A fixed system cursor, so the window never changes it under ours.
            ctx.output_mut(|o| o.cursor_icon = CursorIcon::Default);
        }
        native.show(wanted, ctx);
    }
}

/// The cursor's size in device pixels for a screen scale.
fn pixels(scale: f32) -> u32 {
    (SIZE * scale).round().clamp(16.0, 128.0) as u32
}

/// The click point of `shape` drawn at `px` pixels.
fn hotspot(shape: &Shape, px: u32) -> (u32, u32) {
    let factor = px as f32 / SIZE;
    let clamp = |v: f32| (v * factor).clamp(0.0, (px - 1) as f32) as u32;
    (clamp(shape.hotspot.0), clamp(shape.hotspot.1))
}

/// Draw one shape at `px` pixels; `None` if the artwork does not parse.
fn render(shape: &Shape, dark: bool, px: u32) -> Option<Image> {
    let tree = resvg::usvg::Tree::from_str(shape.svg(dark), &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = Pixmap::new(px, px)?;
    let scale = px as f32 / tree.size().width();
    resvg::render(&tree, Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    let mut rgba = Vec::with_capacity((px * px * 4) as usize);
    for pixel in pixmap.pixels() {
        let c = pixel.demultiply();
        rgba.extend_from_slice(&[c.red(), c.green(), c.blue(), c.alpha()]);
    }
    Some(Image { px, hotspot: hotspot(shape, px), rgba })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_follow_the_screen_scale_within_limits() {
        assert_eq!(pixels(1.0), 28);
        assert_eq!(pixels(1.5), 42);
        assert_eq!(pixels(2.0), 56);
        assert_eq!(pixels(0.25), 16);
        assert_eq!(pixels(10.0), 128);
    }

    #[test]
    fn every_shape_draws_with_its_click_point_inside() {
        for shape in &tma_ui::cursors::SHAPES {
            for dark in [false, true] {
                let image = render(shape, dark, 56);
                assert!(image.is_some(), "{} does not draw", shape.name);
                let Some(image) = image else { continue };
                assert_eq!(image.rgba.len(), 56 * 56 * 4);
                assert!(image.rgba.chunks(4).any(|p| p[3] > 0), "{} is blank", shape.name);
                assert!(image.hotspot.0 < 56 && image.hotspot.1 < 56);
            }
        }
        let pointer = tma_ui::cursors::SHAPES.iter().find(|s| s.name == "pointer");
        assert_eq!(pointer.map(|s| hotspot(s, 56)), Some((22, 8)));
    }
}
