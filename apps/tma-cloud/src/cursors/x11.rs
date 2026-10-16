//! Pointers on X11: Render cursors from the artwork, set as the window's
//! cursor over a connection of our own. winit only redefines the window's
//! cursor when the shape it was asked for changes, and egui's is pinned to
//! Default while ours shows, so ours stays. Wayland keeps the system's.

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use x11rb::connection::Connection;
use x11rb::protocol::render::{ConnectionExt as _, CreatePictureAux, PictType, Pictformat};
use x11rb::protocol::xproto::{ChangeWindowAttributesAux, ConnectionExt as _, CreateGCAux, ImageFormat, ImageOrder};
use x11rb::rust_connection::RustConnection;

use super::Image;

pub type Cursor = u32;

pub struct Native {
    conn: RustConnection,
    root: u32,
    window: u32,
    format: Pictformat,
    shown: Option<Cursor>,
    /// Set the cursor again next frame: winit applies its own after a frame
    /// in which egui's cursor changed back to Default.
    again: bool,
}

impl Native {
    pub fn new(frame: &eframe::Frame) -> Option<Self> {
        let window = match frame.window_handle().ok()?.as_raw() {
            RawWindowHandle::Xlib(h) => u32::try_from(h.window).ok()?,
            RawWindowHandle::Xcb(h) => h.window.get(),
            _ => return None,
        };
        let (conn, screen) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let formats = conn.render_query_pict_formats().ok()?.reply().ok()?;
        let format = formats
            .formats
            .iter()
            .find(|f| {
                let d = &f.direct;
                f.type_ == PictType::DIRECT
                    && f.depth == 32
                    && (d.alpha_shift, d.red_shift, d.green_shift, d.blue_shift) == (24, 16, 8, 0)
                    && [d.alpha_mask, d.red_mask, d.green_mask, d.blue_mask] == [0xFF; 4]
            })?
            .id;
        Some(Self { conn, root, window, format, shown: None, again: true })
    }

    pub fn make(&mut self, image: &Image) -> Option<Cursor> {
        let conn = &self.conn;
        let side = u16::try_from(image.px).ok()?;
        let msb = conn.setup().image_byte_order == ImageOrder::MSB_FIRST;
        let data = argb32(&image.rgba, msb);
        let pixmap = conn.generate_id().ok()?;
        conn.create_pixmap(32, pixmap, self.root, side, side).ok()?;
        let made = self.cursor_from(pixmap, side, &data, image.hotspot);
        let _ = conn.free_pixmap(pixmap);
        let _ = conn.flush();
        made
    }

    fn cursor_from(&self, pixmap: u32, side: u16, data: &[u8], hotspot: (u32, u32)) -> Option<Cursor> {
        let conn = &self.conn;
        let gc = conn.generate_id().ok()?;
        conn.create_gc(gc, pixmap, &CreateGCAux::new()).ok()?;
        let put = conn.put_image(ImageFormat::Z_PIXMAP, pixmap, gc, side, side, 0, 0, 0, 32, data);
        let _ = conn.free_gc(gc);
        put.ok()?;
        let picture = conn.generate_id().ok()?;
        conn.render_create_picture(picture, pixmap, self.format, &CreatePictureAux::new()).ok()?;
        let cursor = conn.generate_id().ok()?;
        let (x, y) = (u16::try_from(hotspot.0).ok()?, u16::try_from(hotspot.1).ok()?);
        let created = conn.render_create_cursor(cursor, picture, x, y).ok().and_then(|c| c.check().ok());
        let _ = conn.render_free_picture(picture);
        created.map(|()| cursor)
    }

    pub fn show(&mut self, cursor: Option<&Cursor>, ctx: &egui::Context) {
        let wanted = cursor.copied();
        let Some(id) = wanted else {
            // winit sets the system shape egui asked for after this frame.
            self.shown = None;
            self.again = true;
            return;
        };
        if self.shown == wanted && !self.again {
            return;
        }
        self.again = self.shown.is_none();
        if self.again {
            ctx.request_repaint();
        }
        self.shown = wanted;
        let attributes = ChangeWindowAttributesAux::new().cursor(id);
        if self.conn.change_window_attributes(self.window, &attributes).is_ok() {
            let _ = self.conn.flush();
        }
    }
}

/// Straight RGBA to premultiplied 32-bit ARGB pixels in the server's byte order.
fn argb32(rgba: &[u8], msb: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for p in rgba.as_chunks::<4>().0 {
        let a = u16::from(p[3]);
        let pre = |c: u8| ((u16::from(c) * a + 127) / 255) as u8;
        let pixel = u32::from_be_bytes([p[3], pre(p[0]), pre(p[1]), pre(p[2])]);
        out.extend_from_slice(&if msb { pixel.to_be_bytes() } else { pixel.to_le_bytes() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixels_are_premultiplied_in_server_order() {
        let rgba = [255, 128, 0, 128, 10, 20, 30, 255];
        assert_eq!(argb32(&rgba, false), [0, 64, 128, 128, 30, 20, 10, 255]);
        assert_eq!(argb32(&rgba, true), [128, 128, 64, 0, 255, 10, 20, 30]);
    }
}
