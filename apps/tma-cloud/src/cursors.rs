//! TMA Cloud's own pointers on Windows. egui only picks system cursors, so the
//! artwork from `tma_ui::cursors` is drawn at the screen's scale, made into
//! real cursors, and shown by handling WM_SETCURSOR for the app window.
#![allow(unsafe_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicIsize, Ordering};

use egui::CursorIcon;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use resvg::tiny_skia::{Pixmap, Transform};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BI_BITFIELDS, BITMAPINFO, BITMAPV5HEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS, DeleteObject, HGDIOBJ,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, HCURSOR, HTCLIENT, ICONINFO, SetCursor, WM_SETCURSOR,
};

/// The cursor to show over the window's content; 0 leaves it to the window's own handling.
static SHOWN: AtomicIsize = AtomicIsize::new(0);

#[derive(Default)]
pub struct Cursors {
    hooked: bool,
    made: HashMap<(&'static str, bool, u32), isize>,
    current: isize,
}

impl Cursors {
    /// Run after each frame: swap the cursor egui asked for for the matching artwork.
    pub fn apply(&mut self, ctx: &egui::Context, frame: &eframe::Frame, dark: bool) {
        if !self.hooked {
            self.hooked = hook(frame);
        }
        let icon = ctx.output(|o| o.cursor_icon);
        let scale = ctx.input(|i| i.viewport().native_pixels_per_point).unwrap_or(1.0);
        let wanted = match tma_ui::cursors::for_icon(icon).filter(|_| self.hooked) {
            Some(shape) => self.cursor(shape, dark, scale),
            None => 0,
        };
        if wanted != 0 {
            // A fixed system cursor, so winit never changes it under ours.
            ctx.output_mut(|o| o.cursor_icon = CursorIcon::Default);
        }
        if wanted != self.current {
            self.current = wanted;
            SHOWN.store(wanted, Ordering::Relaxed);
            if wanted != 0 && ctx.input(|i| i.pointer.has_pointer()) {
                // SAFETY: `wanted` is a cursor this process made and never destroys; this is the window's thread.
                unsafe { SetCursor(Some(HCURSOR(wanted as *mut _))) };
            }
        }
    }

    fn cursor(&mut self, shape: &'static tma_ui::cursors::Shape, dark: bool, scale: f32) -> isize {
        let px = (tma_ui::cursors::SIZE * scale).round().clamp(16.0, 128.0) as u32;
        if let Some(made) = self.made.get(&(shape.name, dark, px)) {
            return *made;
        }
        let made = make(shape, dark, px).unwrap_or(0);
        self.made.insert((shape.name, dark, px), made);
        made
    }
}

/// Route the window's WM_SETCURSOR through `on_message`.
fn hook(frame: &eframe::Frame) -> bool {
    let Ok(handle) = frame.window_handle() else { return false };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return false };
    let hwnd = HWND(win32.hwnd.get() as *mut _);
    // SAFETY: the handle is this app's live top-level window, and `on_message` matches SUBCLASSPROC.
    unsafe { SetWindowSubclass(hwnd, Some(on_message), 1, 0) }.as_bool()
}

unsafe extern "system" fn on_message(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    if msg == WM_SETCURSOR && (lparam.0 & 0xFFFF) as u32 == HTCLIENT {
        let shown = SHOWN.load(Ordering::Relaxed);
        if shown != 0 {
            // SAFETY: `shown` is a cursor this process made and never destroys.
            unsafe { SetCursor(Some(HCURSOR(shown as *mut _))) };
            return LRESULT(1);
        }
    }
    // SAFETY: passes the message on unchanged, as a subclass procedure must.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

/// Draw one shape at `px` pixels and make it a cursor; `None` if Windows refuses.
fn make(shape: &tma_ui::cursors::Shape, dark: bool, px: u32) -> Option<isize> {
    let tree = resvg::usvg::Tree::from_str(shape.svg(dark), &resvg::usvg::Options::default()).ok()?;
    let mut pixmap = Pixmap::new(px, px)?;
    let scale = px as f32 / tree.size().width();
    resvg::render(&tree, Transform::from_scale(scale, scale), &mut pixmap.as_mut());
    // Cursors take straight (not premultiplied) alpha, in BGRA order.
    let mut bgra = Vec::with_capacity((px * px * 4) as usize);
    for pixel in pixmap.pixels() {
        let c = pixel.demultiply();
        bgra.extend_from_slice(&[c.blue(), c.green(), c.red(), c.alpha()]);
    }
    let factor = px as f32 / tma_ui::cursors::SIZE;
    let hotspot = ((shape.hotspot.0 * factor) as u32, (shape.hotspot.1 * factor) as u32);
    from_bgra(&bgra, px, hotspot)
}

fn from_bgra(bgra: &[u8], px: u32, hotspot: (u32, u32)) -> Option<isize> {
    let mut header = BITMAPV5HEADER {
        bV5Size: std::mem::size_of::<BITMAPV5HEADER>() as u32,
        bV5Width: px as i32,
        // Negative: rows run top to bottom, as the pixmap's do.
        bV5Height: -(px as i32),
        bV5Planes: 1,
        bV5BitCount: 32,
        bV5Compression: BI_BITFIELDS,
        bV5RedMask: 0x00FF_0000,
        bV5GreenMask: 0x0000_FF00,
        bV5BlueMask: 0x0000_00FF,
        bV5AlphaMask: 0xFF00_0000,
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    // SAFETY: the header describes a 32-bit top-down bitmap and outlives the call;
    // `bits` receives a buffer of exactly px * px * 4 bytes owned by the bitmap.
    let color = unsafe {
        CreateDIBSection(
            None,
            (&mut header as *mut BITMAPV5HEADER).cast::<BITMAPINFO>(),
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
    }
    .ok()?;
    if bits.is_null() || bgra.len() != (px * px * 4) as usize {
        // SAFETY: `color` was just created here and is not used again.
        let _ = unsafe { DeleteObject(HGDIOBJ(color.0)) };
        return None;
    }
    // SAFETY: `bits` points at px * px * 4 writable bytes, the length checked above.
    unsafe { std::ptr::copy_nonoverlapping(bgra.as_ptr(), bits.cast::<u8>(), bgra.len()) };
    // The alpha channel decides the shape; the mask only has to exist.
    // SAFETY: a monochrome bitmap with no initial bits.
    let mask = unsafe { CreateBitmap(px as i32, px as i32, 1, 1, None) };
    let info =
        ICONINFO { fIcon: false.into(), xHotspot: hotspot.0, yHotspot: hotspot.1, hbmMask: mask, hbmColor: color };
    // SAFETY: both bitmaps are valid; Windows copies them into the new cursor.
    let cursor = unsafe { CreateIconIndirect(&info) };
    // SAFETY: the cursor holds its own copies, so these are no longer needed.
    unsafe {
        let _ = DeleteObject(HGDIOBJ(color.0));
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    cursor.ok().map(|c| c.0 as isize)
}
