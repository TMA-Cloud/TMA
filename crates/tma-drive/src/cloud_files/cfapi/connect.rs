//! Connecting the drive folder: Windows calls in from its own threads when an app
//! opens a file not downloaded yet, lists a folder never browsed, or deletes or
//! renames a placeholder, and waits for the answer. A panic in such a callback
//! cannot unwind into Windows and would abort the app, so each one is caught and
//! the request is refused instead; every request gets an answer.
#![expect(unsafe_code, reason = "receives Windows callbacks through the cldapi C API")]

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use windows::Win32::Storage::CloudFilters::{
    CF_CALLBACK_INFO, CF_CALLBACK_PARAMETERS, CF_CALLBACK_REGISTRATION, CF_CALLBACK_RENAME_FLAG_TARGET_IN_SCOPE,
    CF_CALLBACK_TYPE_FETCH_DATA, CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, CF_CALLBACK_TYPE_NONE,
    CF_CALLBACK_TYPE_NOTIFY_DELETE, CF_CALLBACK_TYPE_NOTIFY_RENAME, CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH,
    CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO, CF_CONNECTION_KEY, CfConnectSyncRoot, CfDisconnectSyncRoot,
};
use windows::core::{HSTRING, PCWSTR};

use super::reply::{self, Keys};
use super::{NewPlaceholder, Refusal};

/// The drive's answers to Windows. Each returns Ok once it has answered through
/// `Request`; an Err is sent back as the refusal.
pub trait Handler: Send + Sync {
    /// Download the whole file into the placeholder (`Request::write`).
    fn fetch_data(&self, request: &Request) -> Result<(), Refusal>;
    /// List a folder's items (`Request::list`).
    fn fetch_placeholders(&self, request: &Request) -> Result<(), Refusal>;
    /// Agree to a delete (`Request::allow_delete`) or refuse it.
    fn delete(&self, request: &Request) -> Result<(), Refusal>;
    /// Agree to a rename to `target` (`Request::allow_rename`) or refuse it; `in_scope`
    /// is false when the item leaves the drive folder.
    fn rename(&self, request: &Request, target: &Path, in_scope: bool) -> Result<(), Refusal>;
}

/// One request from Windows, copied out of its callback.
#[derive(Debug)]
pub struct Request {
    /// The drive letter ("C:") that Windows paths in callbacks are relative to.
    volume: OsString,
    path: PathBuf,
    identity: Vec<u8>,
    file_size: u64,
    process_id: u32,
    keys: Keys,
}

impl Request {
    /// The full path of the file or folder asked about.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The identity stored with the placeholder.
    pub fn identity(&self) -> &[u8] {
        &self.identity
    }

    pub fn file_size(&self) -> u64 {
        self.file_size
    }

    /// The process that caused the request.
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Write downloaded bytes; Windows wants whole 4 KiB pages except at the end.
    pub fn write(&self, bytes: &[u8], offset: u64) -> Result<(), String> {
        reply::write(self.keys, bytes, offset).map_err(|e| e.to_string())
    }

    /// Show the download's progress on the file in Explorer.
    pub fn progress(&self, total: u64, done: u64) {
        let _ = reply::progress(self.keys, total, done);
    }

    /// Answer a listing with every item in the folder.
    pub fn list(&self, items: &[NewPlaceholder]) -> Result<(), String> {
        let mut raw: Vec<_> = items.iter().map(NewPlaceholder::raw).collect();
        reply::list(self.keys, &mut raw).map_err(|e| e.to_string())
    }

    pub fn allow_delete(&self) -> Result<(), String> {
        reply::ack_delete(self.keys, windows::Win32::Foundation::STATUS_SUCCESS).map_err(|e| e.to_string())
    }

    pub fn allow_rename(&self) -> Result<(), String> {
        reply::ack_rename(self.keys, windows::Win32::Foundation::STATUS_SUCCESS).map_err(|e| e.to_string())
    }
}

/// A connected drive folder; dropping it disconnects.
pub struct Connection {
    key: CF_CONNECTION_KEY,
    _handler: Arc<dyn Handler>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        // SAFETY: the key came from CfConnectSyncRoot and is disconnected only here.
        let _ = unsafe { CfDisconnectSyncRoot(self.key) };
    }
}

static CALLBACKS: [CF_CALLBACK_REGISTRATION; 5] = [
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_DATA, Callback: Some(on_fetch_data) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, Callback: Some(on_fetch_placeholders) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_DELETE, Callback: Some(on_delete) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NOTIFY_RENAME, Callback: Some(on_rename) },
    CF_CALLBACK_REGISTRATION { Type: CF_CALLBACK_TYPE_NONE, Callback: None },
];

/// Start answering Windows for the registered folder at `root`.
pub fn connect(root: &Path, handler: Arc<dyn Handler>) -> Result<Connection, String> {
    // Callbacks reach the handler through a weak reference, so one arriving after the
    // drive is gone finds nothing and is refused. The box is never freed: Windows may
    // still be inside a callback while it disconnects, and it is a few bytes per sign-in.
    let context = Box::into_raw(Box::new(Arc::downgrade(&handler)));
    // SAFETY: the table is static, the context stays valid for the life of the process,
    // and the path is a valid wide string for the duration of the call.
    let key = unsafe {
        CfConnectSyncRoot(
            &HSTRING::from(root),
            CALLBACKS.as_ptr(),
            Some(context.cast_const().cast()),
            CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH | CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO,
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(Connection { key, _handler: handler })
}

/// A wide C string from Windows, or empty for a null pointer.
///
/// # Safety
/// `text` is null or points to a nul-terminated string valid for this call.
unsafe fn os_string(text: PCWSTR) -> OsString {
    if text.is_null() {
        return OsString::new();
    }
    // SAFETY: non-null and nul-terminated, as the caller promises.
    OsString::from_wide(unsafe { text.as_wide() })
}

/// The handler and a copy of the request, or None if the drive is gone.
///
/// # Safety
/// `info` is the callback info Windows passed, valid for the duration of the callback.
unsafe fn take(info: *const CF_CALLBACK_INFO) -> Option<(Arc<dyn Handler>, Request)> {
    // SAFETY: Windows passes a valid callback info for the duration of the callback.
    let info = unsafe { info.as_ref() }?;
    // SAFETY: the context is the box `connect` leaked, never freed.
    let handler = unsafe { info.CallbackContext.cast::<Weak<dyn Handler>>().as_ref() }?.upgrade()?;
    // SAFETY: the strings are nul-terminated and live as long as the callback.
    let volume = unsafe { os_string(info.VolumeDosName) };
    let mut path = PathBuf::from(&volume);
    // SAFETY: as above.
    path.push(unsafe { os_string(info.NormalizedPath) });
    let identity = if info.FileIdentity.is_null() {
        Vec::new()
    } else {
        // SAFETY: Windows passes the identity's pointer and length together.
        unsafe { std::slice::from_raw_parts(info.FileIdentity.cast::<u8>(), info.FileIdentityLength as usize) }.to_vec()
    };
    // SAFETY: requested at connect; null only if Windows had none to give.
    let process_id = unsafe { info.ProcessInfo.as_ref() }.map_or(0, |p| p.ProcessId);
    let keys = Keys { connection: info.ConnectionKey, transfer: info.TransferKey };
    Some((handler, Request { volume, path, identity, file_size: info.FileSize.max(0) as u64, process_id, keys }))
}

/// Run the handler, turning a panic into a refusal.
fn answer(run: impl FnOnce() -> Result<(), Refusal>) -> Result<(), Refusal> {
    catch_unwind(AssertUnwindSafe(run)).unwrap_or_else(|_| {
        log::error!("[drive] a Cloud Files callback panicked; the request was refused");
        Err(Refusal::Unsuccessful)
    })
}

unsafe extern "system" fn on_fetch_data(info: *const CF_CALLBACK_INFO, params: *const CF_CALLBACK_PARAMETERS) {
    // SAFETY: Windows passes valid pointers for the duration of the callback.
    let Some((handler, request)) = (unsafe { take(info) }) else { return };
    // SAFETY: a FETCH_DATA callback carries the FetchData member.
    let fetch = unsafe { params.as_ref().map(|p| p.Anonymous.FetchData) };
    if let Err(refusal) = answer(|| handler.fetch_data(&request)) {
        let (offset, length) =
            fetch.map_or((0, request.file_size as i64), |f| (f.RequiredFileOffset, f.RequiredLength));
        let _ = reply::fail_write(request.keys, refusal.status(), offset, length);
    }
}

unsafe extern "system" fn on_fetch_placeholders(info: *const CF_CALLBACK_INFO, _params: *const CF_CALLBACK_PARAMETERS) {
    // SAFETY: Windows passes valid pointers for the duration of the callback.
    let Some((handler, request)) = (unsafe { take(info) }) else { return };
    if let Err(refusal) = answer(|| handler.fetch_placeholders(&request)) {
        let _ = reply::fail_list(request.keys, refusal.status());
    }
}

unsafe extern "system" fn on_delete(info: *const CF_CALLBACK_INFO, _params: *const CF_CALLBACK_PARAMETERS) {
    // SAFETY: Windows passes valid pointers for the duration of the callback.
    let Some((handler, request)) = (unsafe { take(info) }) else { return };
    if let Err(refusal) = answer(|| handler.delete(&request)) {
        let _ = reply::ack_delete(request.keys, refusal.status());
    }
}

unsafe extern "system" fn on_rename(info: *const CF_CALLBACK_INFO, params: *const CF_CALLBACK_PARAMETERS) {
    // SAFETY: Windows passes valid pointers for the duration of the callback.
    let Some((handler, request)) = (unsafe { take(info) }) else { return };
    // SAFETY: Windows passes valid parameters for the duration of the callback.
    let (target, in_scope) = unsafe { params.as_ref() }.map_or((PathBuf::new(), false), |p| {
        // SAFETY: a NOTIFY_RENAME callback carries the Rename member.
        let rename = unsafe { p.Anonymous.Rename };
        // The target is on the same volume, without its drive letter.
        let mut target = PathBuf::from(&request.volume);
        // SAFETY: nul-terminated and valid for the callback.
        target.push(unsafe { os_string(rename.TargetPath) });
        (target, (rename.Flags & CF_CALLBACK_RENAME_FLAG_TARGET_IN_SCOPE).0 != 0)
    });
    if let Err(refusal) = answer(|| handler.rename(&request, &target, in_scope)) {
        let _ = reply::ack_rename(request.keys, refusal.status());
    }
}
