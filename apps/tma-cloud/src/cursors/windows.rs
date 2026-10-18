//! Pointers on Windows: Win32 cursors from the artwork, shown by handling
//! WM_SETCURSOR for the app window.
#![expect(unsafe_code, reason = "Win32 cursors and a window procedure hook")]

use std::sync::atomic::{AtomicIsize, Ordering};

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BI_BITFIELDS, BITMAPINFO, BITMAPV5HEADER, CreateBitmap, CreateDIBSection, DIB_RGB_COLORS, DeleteObject, HGDIOBJ,
};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconIndirect, HCURSOR, HTCLIENT, ICONINFO, SetCursor, WM_SETCURSOR,
};

use super::Image;

/// The cursor to show over the window's content; 0 leaves it to the window's own handling.
static SHOWN: AtomicIsize = AtomicIsize::new(0);

pub type Cursor = isize;

pub struct Native {
    current: isize,
}

impl Native {
    pub fn new(frame: &eframe::Frame) -> Option<Self> {
        hook(frame).then_some(Self { current: 0 })
    }

    pub fn make(&mut self, image: &Image) -> Option<Cursor> {
        // Cursors take straight alpha in BGRA order.
        let bgra: Vec<u8> = image.rgba.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], p[3]]).collect();
        from_bgra(&bgra, image.px, image.hotspot)
    }

    pub fn show(&mut self, cursor: Option<&Cursor>, ctx: &egui::Context) {
        let wanted = cursor.copied().unwrap_or(0);
        if wanted != self.current {
            self.current = wanted;
            SHOWN.store(wanted, Ordering::Relaxed);
            if wanted != 0 && ctx.input(|i| i.pointer.has_pointer()) {
                // SAFETY: `wanted` is a cursor this process made and never destroys; this is the window's thread.
                unsafe { SetCursor(Some(HCURSOR(wanted as *mut _))) };
            }
        }
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
