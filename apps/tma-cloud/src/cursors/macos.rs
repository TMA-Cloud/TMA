//! Pointers on macOS: an NSCursor per shape, drawn at device pixels with its
//! size in points. AppKit puts winit's arrow back when the pointer enters the
//! window or the window's cursor rects change, so ours is set every frame
//! while the pointer is over the window.

use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_app_kit::{NSCursor, NSImage};
use objc2_foundation::{NSData, NSPoint, NSSize};
use tma_ui::cursors::SIZE;

use super::Image;

pub type Cursor = Retained<NSCursor>;

pub struct Native {
    showing: bool,
}

impl Native {
    pub fn new(_frame: &eframe::Frame) -> Option<Self> {
        Some(Self { showing: false })
    }

    pub fn make(&mut self, image: &Image) -> Option<Cursor> {
        let mut png = Vec::new();
        PngEncoder::new(&mut png).write_image(&image.rgba, image.px, image.px, image::ExtendedColorType::Rgba8).ok()?;
        let picture = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&png))?;
        picture.setSize(NSSize::new(f64::from(SIZE), f64::from(SIZE)));
        // The hot spot counts from the image's top-left corner, in points.
        let points = f64::from(SIZE) / f64::from(image.px);
        let (x, y) = (f64::from(image.hotspot.0) * points, f64::from(image.hotspot.1) * points);
        Some(NSCursor::initWithImage_hotSpot(NSCursor::alloc(), &picture, NSPoint::new(x, y)))
    }

    pub fn show(&mut self, cursor: Option<&Cursor>, ctx: &egui::Context) {
        let Some(cursor) = cursor else {
            self.showing = false;
            return;
        };
        if !self.showing {
            // winit resets the window's cursor rects after this frame; the next one wins.
            self.showing = true;
            ctx.request_repaint();
        }
        if ctx.input(|i| i.pointer.has_pointer()) {
            cursor.set();
        }
    }
}
