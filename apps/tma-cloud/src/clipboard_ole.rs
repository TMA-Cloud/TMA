//! Files on the clipboard that exist only inside another app: Outlook
//! attachments and messages, files inside a zip opened in Explorer. Windows
//! hands them out through OLE as memory, a stream or a structured storage.
#![allow(unsafe_code)]

use std::io::Write;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::StructuredStorage::{
    CreateILockBytesOnHGlobal, GetHGlobalFromILockBytes, StgCreateDocfileOnILockBytes,
};
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, DVASPECT_CONTENT, FORMATETC, IDataObject, STATFLAG_NONAME, STATSTG,
    STGC_DEFAULT, STGM_CREATE, STGM_READWRITE, STGM_SHARE_EXCLUSIVE, STGMEDIUM, TYMED, TYMED_HGLOBAL, TYMED_ISTORAGE,
    TYMED_ISTREAM,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{OleGetClipboard, ReleaseStgMedium};

use crate::clip_plan;

fn format(name: &str) -> Option<u16> {
    clipboard_win::register_format(name).and_then(|n| u16::try_from(n.get()).ok())
}

/// Whether another app put virtual files on the clipboard; cheap, checked often.
pub fn available() -> bool {
    format("FileGroupDescriptorW").is_some_and(|f| clipboard_win::is_format_avail(u32::from(f)))
}

/// A medium from `GetData`, released once when dropped.
struct Medium(STGMEDIUM);

impl Drop for Medium {
    fn drop(&mut self) {
        // SAFETY: the medium came from IDataObject::GetData and is released exactly once here.
        unsafe { ReleaseStgMedium(&mut self.0) };
    }
}

fn get(data: &IDataObject, format: u16, index: i32, tymed: TYMED) -> Result<Medium, String> {
    let request = FORMATETC {
        cfFormat: format,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: tymed.0 as u32,
    };
    // SAFETY: `request` is a valid FORMATETC for the duration of the call.
    unsafe { data.GetData(&request) }
        .map(Medium)
        .map_err(|e| format!("The copied files could not be read: {}", e.message()))
}

/// The bytes of a global memory block, `len` of them when the size is known.
///
/// # Safety
/// `memory` must be a valid HGLOBAL that stays alive for the call.
unsafe fn global_bytes(memory: HGLOBAL, len: Option<usize>) -> Result<Vec<u8>, String> {
    // SAFETY: the caller guarantees `memory` is valid; the lock is released before returning.
    unsafe {
        let size = len.map_or(GlobalSize(memory), |l| l.min(GlobalSize(memory)));
        let ptr = GlobalLock(memory) as *const u8;
        if ptr.is_null() {
            return Err("The copied data could not be read".into());
        }
        let bytes = std::slice::from_raw_parts(ptr, size).to_vec();
        let _ = GlobalUnlock(memory);
        Ok(bytes)
    }
}

fn write_contents(
    data: &IDataObject,
    format: u16,
    index: i32,
    only: bool,
    path: &Path,
    size: Option<u64>,
) -> Result<(), String> {
    let tymed = TYMED(TYMED_HGLOBAL.0 | TYMED_ISTREAM.0 | TYMED_ISTORAGE.0);
    // Some apps answer a lone file only without an index.
    let medium = match get(data, format, index, tymed) {
        Err(_) if only => get(data, format, -1, tymed)?,
        other => other?,
    };
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let tymed = TYMED(medium.0.tymed as i32);
    let bytes = if tymed == TYMED_HGLOBAL {
        // SAFETY: TYMED_HGLOBAL means `hGlobal` is the member GetData filled in.
        unsafe { global_bytes(medium.0.u.hGlobal, size.map(|s| s as usize))? }
    } else if tymed == TYMED_ISTREAM {
        // SAFETY: TYMED_ISTREAM means `pstm` is the member GetData filled in.
        let stream = unsafe { &*medium.0.u.pstm }.as_ref().ok_or("The copied file is empty")?;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            let mut read = 0u32;
            // SAFETY: `buffer` is writable for its full length and `read` outlives the call.
            let result = unsafe { stream.Read(buffer.as_mut_ptr().cast(), buffer.len() as u32, Some(&mut read)) };
            if result.is_err() || read == 0 {
                break;
            }
            file.write_all(&buffer[..read as usize]).map_err(|e| e.to_string())?;
        }
        return Ok(());
    } else if tymed == TYMED_ISTORAGE {
        // SAFETY: TYMED_ISTORAGE means `pstg` is the member GetData filled in.
        let storage = unsafe { &*medium.0.u.pstg }.as_ref().ok_or("The copied item is empty")?;
        // SAFETY: plain COM calls on live interfaces; the lock bytes own their memory.
        unsafe {
            let lock = CreateILockBytesOnHGlobal(None, true).map_err(|e| e.message())?;
            let copy = StgCreateDocfileOnILockBytes(&lock, STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE, 0)
                .map_err(|e| e.message())?;
            storage.CopyTo(None, None, &copy).map_err(|e| e.message())?;
            copy.Commit(STGC_DEFAULT.0 as u32).map_err(|e| e.message())?;
            let mut stat = STATSTG::default();
            lock.Stat(&mut stat, STATFLAG_NONAME.0 as u32).map_err(|e| e.message())?;
            let memory = GetHGlobalFromILockBytes(&lock).map_err(|e| e.message())?;
            global_bytes(memory, Some(stat.cbSize as usize))?
        }
    } else {
        return Err("The copied file comes in a form TMA Cloud cannot read".into());
    };
    file.write_all(&bytes).map_err(|e| e.to_string())
}

/// Write the clipboard's virtual files under `dest`; returns the top-level paths.
pub fn extract(dest: &Path, limit: u64) -> Result<Vec<PathBuf>, String> {
    let (Some(descriptor), Some(contents)) = (format("FileGroupDescriptorW"), format("FileContents")) else {
        return Ok(Vec::new());
    };
    // SAFETY: initializing COM on this thread; "already initialized" results are fine to ignore.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    // SAFETY: returns an owned reference to the clipboard's data object.
    let data = unsafe { OleGetClipboard() }.map_err(|e| format!("Cannot read the clipboard: {}", e.message()))?;
    let block = {
        let medium = get(&data, descriptor, -1, TYMED_HGLOBAL)?;
        // SAFETY: TYMED_HGLOBAL was the only medium requested, so `hGlobal` is filled in.
        unsafe { global_bytes(medium.0.u.hGlobal, None)? }
    };
    let entries = clip_plan::file_group(&block);
    let total: u64 = entries.iter().filter_map(|e| e.size).sum();
    if total > limit {
        return Err(format!("The copied files are larger than {} MB", limit / (1024 * 1024)));
    }
    let mut written = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let path = dest.join(&entry.path);
        if entry.is_dir {
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            write_contents(&data, contents, index as i32, entries.len() == 1, &path, entry.size)?;
        }
        written.push(entry.path.clone());
    }
    Ok(clip_plan::top_level(&written, dest))
}
