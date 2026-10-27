//! Creating placeholders and changing existing ones.
#![expect(unsafe_code, reason = "creates and updates placeholders through the cldapi C API")]

use std::path::Path;

use windows::Win32::Foundation::{HANDLE, S_FALSE};
use windows::Win32::Storage::CloudFilters::{
    CF_CONVERT_FLAG_MARK_IN_SYNC, CF_CREATE_FLAG_NONE, CF_FS_METADATA, CF_OPEN_FILE_FLAG_EXCLUSIVE,
    CF_OPEN_FILE_FLAG_NONE, CF_OPEN_FILE_FLAG_WRITE_ACCESS, CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
    CF_PLACEHOLDER_CREATE_INFO, CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH, CF_UPDATE_FLAG_CLEAR_IN_SYNC,
    CF_UPDATE_FLAG_DEHYDRATE, CF_UPDATE_FLAG_DISABLE_ON_DEMAND_POPULATION, CF_UPDATE_FLAG_MARK_IN_SYNC,
    CF_UPDATE_FLAG_NONE, CF_UPDATE_FLAG_VERIFY_IN_SYNC, CF_UPDATE_FLAGS, CfCloseHandle, CfConvertToPlaceholder,
    CfCreatePlaceholders, CfOpenFileWithOplock, CfUpdatePlaceholder,
};
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_BASIC_INFO,
};
use windows::core::{HSTRING, PCWSTR};

use super::FileTime;

/// What a placeholder shows before it is opened.
#[derive(Debug, Clone, Copy)]
pub struct Metadata {
    pub folder: bool,
    pub size: u64,
    /// Created, written and changed all show this time.
    pub written: FileTime,
    pub accessed: FileTime,
    /// Someone else is editing it, so Office opens it read-only.
    pub read_only: bool,
}

impl Metadata {
    fn raw(&self) -> CF_FS_METADATA {
        let attributes = match (self.folder, self.read_only) {
            (true, _) => FILE_ATTRIBUTE_DIRECTORY.0,
            (false, true) => FILE_ATTRIBUTE_READONLY.0,
            (false, false) => FILE_ATTRIBUTE_NORMAL.0,
        };
        CF_FS_METADATA {
            BasicInfo: FILE_BASIC_INFO {
                CreationTime: self.written,
                LastAccessTime: self.accessed,
                LastWriteTime: self.written,
                ChangeTime: self.written,
                FileAttributes: attributes,
            },
            FileSize: if self.folder { 0 } else { self.size as i64 },
        }
    }
}

/// A placeholder to create, in sync, standing for the server item named in `identity`.
#[derive(Debug, Clone)]
pub struct NewPlaceholder {
    /// The name, nul-terminated, as Windows reads it.
    name: Vec<u16>,
    identity: Vec<u8>,
    metadata: CF_FS_METADATA,
}

impl NewPlaceholder {
    /// None when the identity is longer than Windows stores.
    pub fn new(name: &str, metadata: Metadata, identity: Vec<u8>) -> Option<Self> {
        if identity.len() > CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH as usize || name.contains('\0') {
            return None;
        }
        let name = name.encode_utf16().chain(std::iter::once(0)).collect();
        Some(Self { name, identity, metadata: metadata.raw() })
    }

    /// The form Windows reads; it points into `self`, which must outlive its use.
    pub(super) fn raw(&self) -> CF_PLACEHOLDER_CREATE_INFO {
        CF_PLACEHOLDER_CREATE_INFO {
            RelativeFileName: PCWSTR(self.name.as_ptr()),
            FsMetadata: self.metadata,
            FileIdentity: if self.identity.is_empty() { std::ptr::null() } else { self.identity.as_ptr().cast() },
            FileIdentityLength: self.identity.len() as u32,
            Flags: CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
            Result: S_FALSE,
            CreateUsn: 0,
        }
    }
}

/// Create placeholders in `dir`, a folder of the sync root.
pub fn create(dir: &Path, items: &[NewPlaceholder]) -> std::io::Result<()> {
    let mut raw: Vec<CF_PLACEHOLDER_CREATE_INFO> = items.iter().map(NewPlaceholder::raw).collect();
    // SAFETY: every entry points into `items`, borrowed for the whole call, and the
    // array is writable for Windows to fill in each entry's result.
    unsafe { CfCreatePlaceholders(&HSTRING::from(dir), &mut raw, CF_CREATE_FLAG_NONE, None) }
        .map_err(std::io::Error::other)?;
    raw.iter().try_for_each(|r| r.Result.ok()).map_err(std::io::Error::other)
}

/// How to change a placeholder; see `Handle::update`.
#[derive(Debug, Clone, Default)]
pub struct Update<'a> {
    pub metadata: Option<Metadata>,
    pub identity: Option<&'a [u8]>,
    /// Only if nothing changed it here since it was last synced.
    pub if_in_sync: bool,
    pub mark_in_sync: bool,
    pub mark_not_in_sync: bool,
    /// Drop the downloaded contents.
    pub dehydrate: bool,
    /// A folder whose items are all on disk: Windows need not ask for them.
    pub listed: bool,
}

impl Update<'_> {
    fn flags(&self) -> CF_UPDATE_FLAGS {
        let mut flags = CF_UPDATE_FLAG_NONE;
        for (on, flag) in [
            (self.if_in_sync, CF_UPDATE_FLAG_VERIFY_IN_SYNC),
            (self.mark_in_sync, CF_UPDATE_FLAG_MARK_IN_SYNC),
            (self.mark_not_in_sync, CF_UPDATE_FLAG_CLEAR_IN_SYNC),
            (self.dehydrate, CF_UPDATE_FLAG_DEHYDRATE),
            (self.listed, CF_UPDATE_FLAG_DISABLE_ON_DEMAND_POPULATION),
        ] {
            if on {
                flags |= flag;
            }
        }
        flags
    }
}

/// A file or folder opened through cldapi to change its placeholder; closed on drop.
pub struct Handle(HANDLE);

impl Handle {
    /// Open for writing; `exclusive` keeps every other opener out (it fails while an app holds the file).
    pub fn open(path: &Path, write: bool, exclusive: bool) -> std::io::Result<Self> {
        let mut flags = CF_OPEN_FILE_FLAG_NONE;
        if write {
            flags |= CF_OPEN_FILE_FLAG_WRITE_ACCESS;
        }
        if exclusive {
            flags |= CF_OPEN_FILE_FLAG_EXCLUSIVE;
        }
        // SAFETY: the path is a valid wide string for the duration of the call.
        unsafe { CfOpenFileWithOplock(&HSTRING::from(path), flags) }.map(Self).map_err(std::io::Error::other)
    }

    /// Make a file or folder made here a placeholder standing for `identity`, in sync.
    pub fn convert(&mut self, identity: &[u8]) -> std::io::Result<()> {
        if identity.len() > CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH as usize {
            return Err(std::io::Error::other("identity too long"));
        }
        // SAFETY: the handle is open while `self` lives and `identity` outlives the call.
        unsafe {
            CfConvertToPlaceholder(
                self.0,
                Some(identity.as_ptr().cast()),
                identity.len() as u32,
                CF_CONVERT_FLAG_MARK_IN_SYNC,
                None,
                None,
            )
        }
        .map_err(std::io::Error::other)
    }

    pub fn update(&mut self, update: &Update<'_>) -> std::io::Result<()> {
        let metadata = update.metadata.map(|m| m.raw());
        let identity = update.identity.unwrap_or_default();
        if identity.len() > CF_PLACEHOLDER_MAX_FILE_IDENTITY_LENGTH as usize {
            return Err(std::io::Error::other("identity too long"));
        }
        // SAFETY: the handle is open while `self` lives; the metadata and identity are
        // borrowed locals that outlive the call; no ranges, USN or overlapped I/O are passed.
        unsafe {
            CfUpdatePlaceholder(
                self.0,
                metadata.as_ref().map(|m| m as *const CF_FS_METADATA),
                (!identity.is_empty()).then(|| identity.as_ptr().cast()),
                identity.len() as u32,
                None,
                update.flags(),
                None,
                None,
            )
        }
        .map_err(std::io::Error::other)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from CfOpenFileWithOplock and is closed only here.
        unsafe { CfCloseHandle(self.0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_with_nul_or_long_identities_are_refused() {
        let meta = Metadata { folder: false, size: 3, written: 0, accessed: 0, read_only: false };
        assert!(NewPlaceholder::new("a\0b", meta, vec![1]).is_none());
        assert!(NewPlaceholder::new("a", meta, vec![0; 4097]).is_none());
        let ok = NewPlaceholder::new("Budget.xlsx", meta, b"id\n3".to_vec()).unwrap();
        assert_eq!(ok.name.last(), Some(&0));
        assert_eq!(ok.raw().FileIdentityLength, 4);
    }

    #[test]
    fn flags_follow_the_update() {
        let update = Update { if_in_sync: true, dehydrate: true, ..Default::default() };
        assert_eq!(update.flags(), CF_UPDATE_FLAG_VERIFY_IN_SYNC | CF_UPDATE_FLAG_DEHYDRATE);
        let meta = Metadata { folder: false, size: 9, written: 5, accessed: 7, read_only: true };
        assert_eq!(meta.raw().BasicInfo.FileAttributes, FILE_ATTRIBUTE_READONLY.0);
        assert_eq!(meta.raw().FileSize, 9);
    }
}
