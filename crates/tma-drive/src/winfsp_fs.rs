//! The Windows adapter: WinFsp callbacks translated to the core. Each open file
//! keeps a core handle and a directory buffer for listings.
// WinFsp hands raw buffers and security descriptors across its C interface.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use windows::Win32::Foundation::{
    STATUS_ACCESS_DENIED, STATUS_BUFFER_OVERFLOW, STATUS_DIRECTORY_NOT_EMPTY, STATUS_END_OF_FILE,
    STATUS_OBJECT_NAME_NOT_FOUND, STATUS_OBJECT_PATH_NOT_FOUND, STATUS_UNEXPECTED_IO_ERROR,
};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
use winfsp::filesystem::{
    DirBuffer, DirInfo, DirMarker, FileInfo, FileSecurity, FileSystemContext, OpenFileInfo, VolumeInfo, WideNameInfo,
};
use winfsp::host::{FileSystemHost, VolumeParams};
use winfsp::{FspError, U16CStr};

use crate::core::{Core, FsError, Handle, Node};

const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
const CLEANUP_DELETE: u32 = 0x01;

impl From<FsError> for FspError {
    fn from(err: FsError) -> Self {
        let status = match err {
            FsError::NotFound => STATUS_OBJECT_NAME_NOT_FOUND,
            FsError::PathNotFound => STATUS_OBJECT_PATH_NOT_FOUND,
            FsError::AccessDenied => STATUS_ACCESS_DENIED,
            FsError::NotEmpty => STATUS_DIRECTORY_NOT_EMPTY,
            FsError::EndOfFile => STATUS_END_OF_FILE,
            FsError::Io(msg) => {
                log::warn!("[drive] {msg}");
                STATUS_UNEXPECTED_IO_ERROR
            }
        };
        status.into()
    }
}

/// 100-ns intervals since 1601, as Windows stores file times.
fn file_time(at: DateTime<Utc>) -> u64 {
    const EPOCH_DIFF_SECS: i64 = 11_644_473_600;
    let at = if at.timestamp() < 0 { Utc::now() } else { at };
    ((at.timestamp() + EPOCH_DIFF_SECS) as u64) * 10_000_000 + u64::from(at.timestamp_subsec_nanos() / 100)
}

fn fill_info(info: &mut FileInfo, node: &Node, size: u64) {
    info.file_attributes = if node.is_folder { FILE_ATTRIBUTE_DIRECTORY.0 } else { FILE_ATTRIBUTE_NORMAL.0 };
    info.file_size = if node.is_folder { 0 } else { size };
    info.allocation_size = info.file_size.div_ceil(4096) * 4096;
    let written = file_time(node.modified);
    info.creation_time = written;
    info.last_write_time = written;
    info.change_time = written;
    info.last_access_time = file_time(node.accessed.unwrap_or(node.modified));
}

fn path_of(name: &U16CStr) -> String {
    name.to_string_lossy()
}

pub struct FileCtx {
    handle: Handle,
    dir: DirBuffer,
}

impl FileCtx {
    fn info(&self, info: &mut FileInfo) {
        fill_info(info, &self.handle.node(), self.handle.size());
    }
}

pub struct CloudFs {
    core: Arc<Core>,
    label: String,
    security: Vec<u8>,
}

impl FileSystemContext for CloudFs {
    type FileContext = FileCtx;

    fn get_security_by_name(
        &self,
        file_name: &U16CStr,
        security_descriptor: Option<&mut [c_void]>,
        _resolver: impl FnOnce(&U16CStr) -> Option<FileSecurity>,
    ) -> winfsp::Result<FileSecurity> {
        let node = self
            .core
            .resolve(&path_of(file_name))
            .map_err(|_| FspError::from(STATUS_OBJECT_PATH_NOT_FOUND))?
            .ok_or(FsError::NotFound)?;
        if let Some(out) = security_descriptor {
            if out.len() < self.security.len() {
                return Err(STATUS_BUFFER_OVERFLOW.into());
            }
            // SAFETY: `out` has room for the descriptor (checked above); both are plain bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.security.as_ptr(),
                    out.as_mut_ptr().cast::<u8>(),
                    self.security.len(),
                )
            };
        }
        let attributes = if node.is_folder { FILE_ATTRIBUTE_DIRECTORY.0 } else { FILE_ATTRIBUTE_NORMAL.0 };
        Ok(FileSecurity { reparse: false, sz_security_descriptor: self.security.len() as u64, attributes })
    }

    fn open(
        &self,
        file_name: &U16CStr,
        _create_options: u32,
        _access: AccessRights,
        file_info: &mut OpenFileInfo,
    ) -> winfsp::Result<FileCtx> {
        let handle = self.core.open(&path_of(file_name))?;
        let ctx = FileCtx { handle, dir: DirBuffer::new() };
        ctx.info(file_info.as_mut());
        Ok(ctx)
    }

    fn close(&self, context: FileCtx) {
        self.core.close(&context.handle);
    }

    fn create(
        &self,
        file_name: &U16CStr,
        create_options: u32,
        _access: AccessRights,
        _attributes: FileAttributes,
        _security: Option<&[c_void]>,
        _allocation_size: u64,
        _extra: Option<&[u8]>,
        _extra_is_reparse: bool,
        file_info: &mut OpenFileInfo,
    ) -> winfsp::Result<FileCtx> {
        let handle = self.core.create(&path_of(file_name), create_options & FILE_DIRECTORY_FILE != 0)?;
        let ctx = FileCtx { handle, dir: DirBuffer::new() };
        ctx.info(file_info.as_mut());
        Ok(ctx)
    }

    fn cleanup(&self, context: &FileCtx, _file_name: Option<&U16CStr>, flags: u32) {
        self.core.cleanup(&context.handle, flags & CLEANUP_DELETE != 0);
    }

    fn flush(&self, context: Option<&FileCtx>, file_info: &mut FileInfo) -> winfsp::Result<()> {
        if let Some(ctx) = context {
            ctx.info(file_info);
        }
        Ok(())
    }

    fn get_file_info(&self, context: &FileCtx, file_info: &mut FileInfo) -> winfsp::Result<()> {
        context.info(file_info);
        Ok(())
    }

    fn get_security(&self, _context: &FileCtx, security_descriptor: Option<&mut [c_void]>) -> winfsp::Result<u64> {
        if let Some(out) = security_descriptor {
            if out.len() < self.security.len() {
                return Err(STATUS_BUFFER_OVERFLOW.into());
            }
            // SAFETY: as in `get_security_by_name`.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.security.as_ptr(),
                    out.as_mut_ptr().cast::<u8>(),
                    self.security.len(),
                )
            };
        }
        Ok(self.security.len() as u64)
    }

    fn overwrite(
        &self,
        context: &FileCtx,
        _attributes: FileAttributes,
        _replace: bool,
        _allocation: u64,
        _extra: Option<&[u8]>,
        file_info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        self.core.overwrite(&context.handle)?;
        context.info(file_info);
        Ok(())
    }

    fn read_directory(
        &self,
        context: &FileCtx,
        _pattern: Option<&U16CStr>,
        marker: DirMarker,
        buffer: &mut [u8],
    ) -> winfsp::Result<u32> {
        if let Ok(lock) = context.dir.acquire(marker.is_none(), None) {
            let folder = context.handle.node();
            let mut entry: DirInfo = DirInfo::new();
            let mut add = |name: &str, node: &Node| {
                entry.reset();
                fill_info(entry.file_info_mut(), node, node.size);
                if entry.set_name(name).is_ok() {
                    let _ = lock.write(&mut entry);
                }
            };
            if folder.path != crate::paths::ROOT {
                add(".", &folder);
                add("..", &folder);
            }
            match self.core.children(&folder) {
                Ok(children) => {
                    for child in &children {
                        add(&child.name, child);
                    }
                }
                Err(err) => log::warn!("[drive] listing failed: {err}"),
            }
        }
        Ok(context.dir.read(marker, buffer))
    }

    fn rename(
        &self,
        _context: &FileCtx,
        file_name: &U16CStr,
        new_file_name: &U16CStr,
        _replace: bool,
    ) -> winfsp::Result<()> {
        Ok(self.core.rename(&path_of(file_name), &path_of(new_file_name))?)
    }

    fn set_basic_info(
        &self,
        context: &FileCtx,
        _attributes: u32,
        _created: u64,
        _accessed: u64,
        _written: u64,
        _changed: u64,
        file_info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        context.info(file_info);
        Ok(())
    }

    fn set_delete(&self, context: &FileCtx, _file_name: &U16CStr, delete: bool) -> winfsp::Result<()> {
        if delete {
            self.core.can_delete(&context.handle)?;
        }
        Ok(())
    }

    fn set_file_size(
        &self,
        context: &FileCtx,
        new_size: u64,
        set_allocation_size: bool,
        file_info: &mut FileInfo,
    ) -> winfsp::Result<()> {
        if !set_allocation_size {
            self.core.set_size(&context.handle, new_size)?;
        }
        context.info(file_info);
        Ok(())
    }

    fn read(&self, context: &FileCtx, buffer: &mut [u8], offset: u64) -> winfsp::Result<u32> {
        Ok(self.core.read(&context.handle, offset, buffer)? as u32)
    }

    fn write(
        &self,
        context: &FileCtx,
        buffer: &[u8],
        offset: u64,
        write_to_eof: bool,
        constrained_io: bool,
        file_info: &mut FileInfo,
    ) -> winfsp::Result<u32> {
        let written = self.core.write(&context.handle, offset, buffer, write_to_eof, constrained_io)?;
        context.info(file_info);
        Ok(written as u32)
    }

    fn get_volume_info(&self, out: &mut VolumeInfo) -> winfsp::Result<()> {
        let (total, free) = self.core.space();
        out.total_size = total;
        out.free_size = free;
        out.set_volume_label(&self.label);
        Ok(())
    }

    fn set_volume_label(&self, _label: &U16CStr, info: &mut VolumeInfo) -> winfsp::Result<()> {
        self.get_volume_info(info)
    }
}

/// The access-right and attribute masks the trait takes (plain `u32` in winfsp's bindings).
type AccessRights = u32;
type FileAttributes = u32;

/// A security descriptor granting the signed-in user, SYSTEM and administrators full access.
fn security_descriptor() -> Vec<u8> {
    use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorLength, GetTokenInformation, PSECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::{HSTRING, PWSTR};

    // SAFETY: Win32 calls with buffers sized from the API's own answers; every
    // allocation the API returns is released with LocalFree.
    let user_sid: Option<String> = unsafe {
        let mut token = HANDLE::default();
        let mut sid_text = None;
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_ok() {
            let mut len = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
            let mut buf = vec![0u8; len as usize];
            if len > 0 && GetTokenInformation(token, TokenUser, Some(buf.as_mut_ptr().cast()), len, &mut len).is_ok() {
                let user = &*(buf.as_ptr().cast::<TOKEN_USER>());
                let mut text = PWSTR::null();
                if ConvertSidToStringSidW(user.User.Sid, &mut text).is_ok() {
                    sid_text = text.to_string().ok();
                    let _ = LocalFree(Some(HLOCAL(text.0.cast())));
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(token);
        }
        sid_text
    };
    let sddl = match &user_sid {
        Some(sid) => format!("O:{sid}G:{sid}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{sid})"),
        None => "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)".to_string(),
    };
    // SAFETY: as above.
    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let mut size = 0u32;
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(sddl),
            SDDL_REVISION_1,
            &mut sd,
            Some(&mut size),
        )
        .is_err()
        {
            return Vec::new();
        }
        let len = if size > 0 { size } else { GetSecurityDescriptorLength(sd) };
        let bytes = std::slice::from_raw_parts(sd.0.cast::<u8>(), len as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        bytes
    }
}

/// Load the installed WinFsp DLL by full path (its folder is not on the search
/// path); the delay-loaded imports then bind to it.
fn load_installed_winfsp() {
    use windows::Win32::System::LibraryLoader::LoadLibraryW;
    use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::{HSTRING, w};

    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: RegGetValueW writes at most `len` bytes into `buf`.
    let found = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\WOW6432Node\WinFsp"),
            w!("InstallDir"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if found.is_err() {
        return;
    }
    let dir = String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]);
    let dll = if cfg!(target_arch = "aarch64") {
        "winfsp-a64.dll"
    } else if cfg!(target_arch = "x86") {
        "winfsp-x86.dll"
    } else {
        "winfsp-x64.dll"
    };
    let path = std::path::Path::new(&dir).join("bin").join(dll);
    // SAFETY: loading a DLL by absolute path; the handle stays loaded for the process.
    if let Err(err) = unsafe { LoadLibraryW(&HSTRING::from(path.as_os_str())) } {
        log::warn!("[drive] cannot load {}: {err}", path.display());
    }
}

/// Whether WinFsp is installed and loadable.
pub fn is_available() -> bool {
    load_installed_winfsp();
    winfsp::winfsp_init().is_ok()
}

/// A mounted drive; dropping it unmounts.
pub struct Mounted {
    host: FileSystemHost<CloudFs>,
    pub mount_point: String,
    pub core: Arc<Core>,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for Mounted {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.host.stop();
        self.host.unmount();
        self.core.clean_staging(true);
    }
}

/// Mount `core` at the highest free drive letter (or `letter`, like "T:").
pub fn mount(core: Arc<Core>, label: &str, letter: Option<&str>) -> Result<Mounted, String> {
    if !is_available() {
        return Err("WinFsp is not installed".into());
    }
    let mut params = VolumeParams::new();
    params
        .sector_size(4096)
        .sectors_per_allocation_unit(1)
        .max_component_length(255)
        .volume_creation_time(file_time(Utc::now()))
        .volume_serial_number((Utc::now().timestamp() & 0xffff_ffff) as u32)
        .case_sensitive_search(false)
        .case_preserved_names(true)
        .unicode_on_disk(true)
        .persistent_acls(false)
        .post_cleanup_when_modified_only(false)
        .flush_and_purge_on_cleanup(true)
        .file_info_timeout(1000)
        .filesystem_name("TMA Cloud");
    let fs = CloudFs { core: core.clone(), label: label.to_string(), security: security_descriptor() };
    let mut host = FileSystemHost::new(params, fs).map_err(|e| format!("Cannot create the drive: {e:?}"))?;
    let mount_point = mount_letter(&mut host, letter)?;
    host.start().map_err(|e| format!("Cannot start the drive: {e:?}"))?;
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Volume size follows the account's quota.
    let (refresh_core, refresh_stop) = (core.clone(), stop.clone());
    std::thread::Builder::new()
        .name("drive-space".into())
        .spawn(move || {
            while !refresh_stop.load(std::sync::atomic::Ordering::Relaxed) {
                refresh_core.refresh_space();
                for _ in 0..30 {
                    if refresh_stop.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(Mounted { host, mount_point, core, stop })
}

/// Try the requested letter, else the free letters from Z: down to D:.
fn mount_letter(host: &mut FileSystemHost<CloudFs>, letter: Option<&str>) -> Result<String, String> {
    if let Some(letter) = letter {
        return host.mount(letter).map(|_| letter.to_string()).map_err(|e| format!("Cannot mount at {letter}: {e:?}"));
    }
    for c in ('D'..='Z').rev() {
        let candidate = format!("{c}:");
        if std::path::Path::new(&format!("{candidate}\\")).exists() {
            continue;
        }
        if host.mount(candidate.as_str()).is_ok() {
            return Ok(candidate);
        }
    }
    Err("No free drive letter for TMA Cloud".into())
}
