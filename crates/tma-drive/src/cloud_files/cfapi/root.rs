//! Registering the drive folder with Windows as a sync root, as OneDrive does,
//! through the WinRT `StorageProviderSyncRootManager`.
#![expect(unsafe_code, reason = "reads the user's SID through the Win32 security API")]

use std::path::{Path, PathBuf};

use windows::Storage::Provider::{
    StorageProviderHydrationPolicy, StorageProviderInSyncPolicy, StorageProviderPopulationPolicy,
    StorageProviderProtectionMode, StorageProviderSyncRootInfo, StorageProviderSyncRootManager,
};
use windows::Storage::StorageFolder;
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_NOT_FOUND, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TOKEN_USER, TokenUser};
use windows::core::{HSTRING, PWSTR};

/// What to register: the folder, the id ("Provider!SID!account") and how Explorer shows it.
pub struct RootSpec<'a> {
    pub id: &'a str,
    pub folder: &'a Path,
    pub display_name: &'a str,
    /// "path,index" of the icon resource.
    pub icon: &'a str,
    pub version: &'a str,
}

/// Cloud Files arrived in Windows 10 1709.
pub fn is_supported() -> bool {
    StorageProviderSyncRootManager::IsSupported().unwrap_or(false)
}

/// The sync roots registered for the signed-in Windows user, any provider: id and folder.
pub fn active_roots() -> Result<Vec<(String, PathBuf)>, String> {
    let roots = StorageProviderSyncRootManager::GetCurrentSyncRoots().map_err(|e| e.to_string())?;
    Ok(roots.into_iter().filter_map(|info| Some((info.Id().ok()?.to_string_lossy(), folder_of(&info)?))).collect())
}

fn folder_of(info: &StorageProviderSyncRootInfo) -> Option<PathBuf> {
    Some(PathBuf::from(info.Path().ok()?.Path().ok()?.to_os_string()))
}

/// The folder registered under `id`, or None if nothing is.
pub fn registered_path(id: &str) -> Result<Option<PathBuf>, String> {
    match StorageProviderSyncRootManager::GetSyncRootInformationForId(&HSTRING::from(id)) {
        Ok(info) => Ok(folder_of(&info)),
        Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn register(spec: &RootSpec<'_>) -> Result<(), String> {
    let run = || -> windows::core::Result<()> {
        let info = StorageProviderSyncRootInfo::new()?;
        info.SetId(&HSTRING::from(spec.id))?;
        info.SetPath(&StorageFolder::GetFolderFromPathAsync(&HSTRING::from(spec.folder))?.join()?)?;
        info.SetDisplayNameResource(&HSTRING::from(spec.display_name))?;
        info.SetIconResource(&HSTRING::from(spec.icon))?;
        info.SetVersion(&HSTRING::from(spec.version))?;
        // Files download whole when opened; a folder lists all its items at once.
        info.SetHydrationPolicy(StorageProviderHydrationPolicy::Full)?;
        info.SetPopulationPolicy(StorageProviderPopulationPolicy::Full)?;
        info.SetProtectionMode(StorageProviderProtectionMode::Personal)?;
        info.SetAllowPinning(true)?;
        // Changing only a write time does not make a file "changed here".
        info.SetInSyncPolicy(
            StorageProviderInSyncPolicy::FileLastWriteTime | StorageProviderInSyncPolicy::DirectoryLastWriteTime,
        )?;
        StorageProviderSyncRootManager::Register(&info)
    };
    run().map_err(|e| e.to_string())
}

pub fn unregister(id: &str) -> Result<(), String> {
    StorageProviderSyncRootManager::Unregister(&HSTRING::from(id)).map_err(|e| e.to_string())
}

/// The signed-in Windows user's SID ("S-1-5-21-…"), which names the sync root.
pub fn current_user_sid() -> Result<String, String> {
    // The calling thread's effective token (GetCurrentThreadEffectiveToken).
    const TOKEN: HANDLE = HANDLE(-6isize as *mut core::ffi::c_void);
    let mut size = 0u32;
    // SAFETY: a size query: no buffer is passed and `size` is writable.
    if let Err(e) = unsafe { GetTokenInformation(TOKEN, TokenUser, None, 0, &mut size) }
        && e.code() != ERROR_INSUFFICIENT_BUFFER.to_hresult()
    {
        return Err(e.to_string());
    }
    // u64 words keep the buffer aligned for the TOKEN_USER Windows writes into it.
    let mut words = vec![0u64; (size as usize).div_ceil(8).max(1)];
    // SAFETY: the buffer is writable for `size` bytes and outlives the call.
    unsafe { GetTokenInformation(TOKEN, TokenUser, Some(words.as_mut_ptr().cast()), size, &mut size) }
        .map_err(|e| e.to_string())?;
    // SAFETY: Windows filled the aligned buffer with a TOKEN_USER, whose SID points into it.
    let sid = unsafe { &*words.as_ptr().cast::<TOKEN_USER>() }.User.Sid;
    let mut text = PWSTR::null();
    // SAFETY: `sid` is valid while `words` lives; Windows allocates `text`, freed below.
    unsafe { ConvertSidToStringSidW(sid, &mut text) }.map_err(|e| e.to_string())?;
    // SAFETY: Windows returned a nul-terminated string.
    let result = unsafe { text.to_string() }.map_err(|e| e.to_string());
    // SAFETY: `text` was allocated with LocalAlloc by ConvertSidToStringSidW.
    unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
    result
}
