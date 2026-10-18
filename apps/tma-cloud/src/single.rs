//! One app at a time on Windows: a second launch brings the running window
//! forward and exits, so two copies never fight over Cloud Drive.
#![expect(unsafe_code, reason = "a named mutex and window calls through Win32")]

use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow};
use windows::core::w;

/// Held for the life of the process; Windows frees it when the process ends.
pub struct Guard(#[expect(dead_code, reason = "held only so Windows keeps the mutex until the process ends")] HANDLE);

/// `None` when another copy is running (its window has been brought forward).
/// If the check itself fails, this copy runs.
pub fn claim() -> Option<Guard> {
    // SAFETY: a named mutex with default security; the name is a static wide string.
    let Ok(mutex) = (unsafe { CreateMutexW(None, true, w!("Local\\TMACloudDesktop")) }) else {
        return Some(Guard(HANDLE::default()));
    };
    // SAFETY: reads this thread's last error, set by the call just above.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        focus_running();
        return None;
    }
    Some(Guard(mutex))
}

fn focus_running() {
    // winit's window class, with the app's title, so an Explorer window named "TMA Cloud" never matches.
    // SAFETY: both arguments are static wide strings.
    let Ok(hwnd) = (unsafe { FindWindowW(w!("Window Class"), w!("TMA Cloud")) }) else { return };
    // SAFETY: `hwnd` is a live top-level window found just above.
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
}
