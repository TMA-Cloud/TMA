//! A placeholder's state, read straight from cldapi without opening it for data, so
//! nothing downloads and no app holding the file is in the way.
#![expect(unsafe_code, reason = "reads placeholder state through the cldapi C API")]

use std::mem::{offset_of, size_of};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows::Win32::Foundation::{ERROR_NOT_A_CLOUD_FILE, HANDLE};
use windows::Win32::Storage::CloudFilters::{
    CF_IN_SYNC_STATE_IN_SYNC, CF_PLACEHOLDER_INFO_STANDARD, CF_PLACEHOLDER_STANDARD_INFO, CF_PLACEHOLDER_STATE_PARTIAL,
    CF_SET_IN_SYNC_FLAG_NONE, CfGetPlaceholderInfo, CfGetPlaceholderStateFromAttributeTag, CfSetInSyncState,
};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_TAG_INFO, FileAttributeTagInfo, GetFileInformationByHandleEx,
};

/// The largest identity Windows stores with a placeholder.
const MAX_IDENTITY: usize = 4096;
const FILE_READ_ATTRIBUTES: u32 = 0x80;
const WRITE_DAC: u32 = 0x0004_0000;
/// Lets a folder be opened as a file handle.
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

pub struct State {
    pub identity: Vec<u8>,
    pub in_sync: bool,
    /// A folder whose contents have not been listed yet (or a file not downloaded).
    pub partial: bool,
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_ne_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn open(path: &Path) -> std::io::Result<std::fs::File> {
    // Attributes only, shared with everyone: never downloads the file or gets in an app's way.
    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

fn partial(file: &std::fs::File) -> std::io::Result<bool> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: `tag` is a writable FILE_ATTRIBUTE_TAG_INFO of the size passed, and
    // the handle is open for as long as `file` lives.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(std::io::Error::other)?;
    // SAFETY: a pure function of the two values passed.
    let state = unsafe { CfGetPlaceholderStateFromAttributeTag(tag.FileAttributes, tag.ReparseTag) };
    Ok(state.0 & CF_PLACEHOLDER_STATE_PARTIAL.0 != 0)
}

/// Mark a placeholder in sync again. WRITE_DAC is enough for that and, unlike write
/// access, is granted on a read-only file (one someone else is editing).
pub fn mark_in_sync(path: &Path) -> std::io::Result<()> {
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES | WRITE_DAC)
        .share_mode(7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    // SAFETY: the handle is open for as long as `file` lives, and no USN is passed back.
    unsafe { CfSetInSyncState(HANDLE(file.as_raw_handle()), CF_IN_SYNC_STATE_IN_SYNC, CF_SET_IN_SYNC_FLAG_NONE, None) }
        .map_err(std::io::Error::other)
}

/// Whether a folder's contents are on disk (a folder placeholder never browsed is not).
pub fn is_populated(path: &Path) -> bool {
    open(path).and_then(|f| partial(&f)).is_ok_and(|p| !p)
}

/// A placeholder's state; `None` for an ordinary file or folder.
pub fn state(path: &Path) -> std::io::Result<Option<State>> {
    let file = open(path)?;
    // u64 words keep the buffer aligned for the struct Windows writes into it.
    let mut words = vec![0u64; (size_of::<CF_PLACEHOLDER_STANDARD_INFO>() + MAX_IDENTITY).div_ceil(8)];
    let len = (words.len() * 8) as u32;
    let mut returned = 0u32;
    // SAFETY: the buffer is writable for `len` bytes and outlives the call, and the
    // file stays open until it drops at the end of this function.
    let result = unsafe {
        CfGetPlaceholderInfo(
            HANDLE(file.as_raw_handle()),
            CF_PLACEHOLDER_INFO_STANDARD,
            words.as_mut_ptr().cast(),
            len,
            Some(&mut returned),
        )
    };
    match result {
        Ok(()) => {}
        Err(err) if err.code() == ERROR_NOT_A_CLOUD_FILE.to_hresult() => return Ok(None),
        Err(err) => return Err(std::io::Error::other(err)),
    }
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_ne_bytes()).collect();
    let in_sync = read_u32(&bytes, offset_of!(CF_PLACEHOLDER_STANDARD_INFO, InSyncState))
        .is_some_and(|s| s as i32 == CF_IN_SYNC_STATE_IN_SYNC.0);
    let start = offset_of!(CF_PLACEHOLDER_STANDARD_INFO, FileIdentity);
    let length = read_u32(&bytes, offset_of!(CF_PLACEHOLDER_STANDARD_INFO, FileIdentityLength)).unwrap_or(0) as usize;
    let end = (start + length).min(returned as usize).min(bytes.len());
    let identity = bytes.get(start..end).unwrap_or_default().to_vec();
    Ok(Some(State { identity, in_sync, partial: partial(&file)? }))
}
