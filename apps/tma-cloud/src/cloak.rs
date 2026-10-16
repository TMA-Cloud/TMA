//! Keeping the window off the screen while it opens (DWM cloaking): unlike
//! hiding it, a cloaked window is still shown, maximized and drawn, so it
//! appears in one step once it is ready. See `window::Reveal`.
#![allow(unsafe_code)]

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAK, DwmSetWindowAttribute};

/// Cloak (`true`) or uncloak the app window. Failing only means it shows as before.
pub fn set(frame: &eframe::Frame, cloaked: bool) {
    let Ok(handle) = frame.window_handle() else { return };
    let RawWindowHandle::Win32(win32) = handle.as_raw() else { return };
    let hwnd = HWND(win32.hwnd.get() as *mut _);
    // A Win32 BOOL: a 32-bit integer.
    let value = i32::from(cloaked);
    // SAFETY: hwnd is this app's live window (eframe owns it for the whole frame), and
    // DWMWA_CLOAK takes a 32-bit BOOL whose address and size are passed together.
    let result = unsafe {
        DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, std::ptr::from_ref(&value).cast(), std::mem::size_of::<i32>() as u32)
    };
    if let Err(err) = result {
        log::debug!("window cloak: {err}");
    }
}
