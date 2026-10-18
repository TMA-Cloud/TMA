//! The titles of other programs' visible windows. Almost every program names
//! the open file in its title ("Notes.txt - Notepad", "Photo.jpg"), so this is
//! how Edit in app tells a file opened from TMA Cloud is still open, whichever
//! program took it and however it was started.
#![expect(unsafe_code, reason = "window enumeration is a Win32 callback API")]

use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};
use windows::core::BOOL;

/// Titles of the visible top-level windows of every program but this one.
pub fn titles() -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    // SAFETY: the callback only runs during this call, and the LPARAM points at
    // `titles`, which outlives it and is touched by nothing else meanwhile.
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(std::ptr::from_mut(&mut titles) as isize)) };
    titles
}

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam is the `&mut Vec<String>` passed by `titles` for the length of EnumWindows.
    let titles = unsafe { &mut *(lparam.0 as *mut Vec<String>) };
    let mut pid = 0u32;
    // SAFETY: hwnd comes from EnumWindows; the calls only read it, and the text
    // buffer is sized from the window's own text length.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(hwnd);
        if len > 0 {
            let mut buf = vec![0u16; len as usize + 1];
            let read = GetWindowTextW(hwnd, &mut buf);
            titles.push(String::from_utf16_lossy(&buf[..read.max(0) as usize]));
        }
    }
    BOOL(1)
}
