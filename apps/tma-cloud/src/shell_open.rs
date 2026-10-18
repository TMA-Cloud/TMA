//! Opening a file in its program the way Explorer does, but keeping a handle to
//! the program Windows starts, so Edit in app can hold the file's edit lock until
//! it exits. A file handed to a program that is already running (or to a Store
//! app) comes back without one; nothing is watched then.
#![expect(unsafe_code, reason = "ShellExecuteExW and the process handle it returns are Win32 calls")]

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{INFINITE, WaitForSingleObject};
use windows::Win32::UI::Shell::{
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::w;

/// The program Windows started for a file.
pub struct Program(HANDLE);

// SAFETY: a process handle is a kernel object reference, usable from any thread.
unsafe impl Send for Program {}

impl Program {
    /// Block until the program exits.
    pub fn wait(&self) {
        // SAFETY: self.0 is a live process handle owned by this value until drop.
        unsafe {
            WaitForSingleObject(self.0, INFINITE);
        }
    }
}

impl Drop for Program {
    fn drop(&mut self) {
        // SAFETY: the handle came from ShellExecuteExW and is closed exactly once, here.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Open `path` with its default program. `Ok(None)` when it opened without a new
/// process to watch; `Err` when no program opened it (no app is set for the type).
pub fn open(path: &Path) -> windows::core::Result<Option<Program>> {
    let file: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // No error dialog: the caller falls back to Open With.
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpVerb: w!("open"),
        lpFile: windows::core::PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // SAFETY: info is fully initialised with its own size, and `file` (NUL-terminated)
    // outlives the call.
    unsafe { ShellExecuteExW(&mut info)? };
    Ok((!info.hProcess.is_invalid() && !info.hProcess.0.is_null()).then_some(Program(info.hProcess)))
}
