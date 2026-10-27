//! Answers to Windows' requests, sent with `CfExecute`.
#![expect(unsafe_code, reason = "answers Windows through the cldapi C API")]

use std::mem::{offset_of, size_of};

use windows::Win32::Foundation::{NTSTATUS, STATUS_SUCCESS};
use windows::Win32::Storage::CloudFilters::{
    CF_CONNECTION_KEY, CF_OPERATION_ACK_DELETE_FLAG_NONE, CF_OPERATION_ACK_RENAME_FLAG_NONE, CF_OPERATION_INFO,
    CF_OPERATION_PARAMETERS, CF_OPERATION_PARAMETERS_0, CF_OPERATION_PARAMETERS_0_0, CF_OPERATION_PARAMETERS_0_4,
    CF_OPERATION_PARAMETERS_0_6, CF_OPERATION_PARAMETERS_0_7, CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
    CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION, CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_NONE,
    CF_OPERATION_TYPE, CF_OPERATION_TYPE_ACK_DELETE, CF_OPERATION_TYPE_ACK_RENAME, CF_OPERATION_TYPE_TRANSFER_DATA,
    CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS, CF_PLACEHOLDER_CREATE_INFO, CfExecute, CfReportProviderProgress,
};

/// Which request an answer is for.
#[derive(Debug, Clone, Copy)]
pub(super) struct Keys {
    pub connection: CF_CONNECTION_KEY,
    pub transfer: i64,
}

fn execute<F>(keys: Keys, kind: CF_OPERATION_TYPE, params: CF_OPERATION_PARAMETERS_0) -> windows::core::Result<()> {
    let info = CF_OPERATION_INFO {
        StructSize: size_of::<CF_OPERATION_INFO>() as u32,
        Type: kind,
        ConnectionKey: keys.connection,
        TransferKey: keys.transfer,
        ..Default::default()
    };
    // The size covers the header and the one union member this operation uses.
    let mut params = CF_OPERATION_PARAMETERS {
        ParamSize: (offset_of!(CF_OPERATION_PARAMETERS, Anonymous) + size_of::<F>()) as u32,
        Anonymous: params,
    };
    // SAFETY: both structs are fully initialised and outlive the call, and any buffer
    // the union points at is borrowed by the caller for at least as long.
    unsafe { CfExecute(&info, &mut params) }
}

fn transfer(keys: Keys, status: NTSTATUS, buffer: *const u8, offset: i64, length: i64) -> windows::core::Result<()> {
    let data = CF_OPERATION_PARAMETERS_0_0 {
        Flags: CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
        CompletionStatus: status,
        Buffer: buffer.cast(),
        Offset: offset,
        Length: length,
    };
    execute::<CF_OPERATION_PARAMETERS_0_0>(
        keys,
        CF_OPERATION_TYPE_TRANSFER_DATA,
        CF_OPERATION_PARAMETERS_0 { TransferData: data },
    )
}

/// Write downloaded bytes at `offset` of the file being opened.
pub(super) fn write(keys: Keys, bytes: &[u8], offset: u64) -> windows::core::Result<()> {
    transfer(keys, STATUS_SUCCESS, bytes.as_ptr(), offset as i64, bytes.len() as i64)
}

/// Fail a download over the range Windows asked for; a zero-length failure is refused.
pub(super) fn fail_write(keys: Keys, status: NTSTATUS, offset: i64, length: i64) -> windows::core::Result<()> {
    transfer(keys, status, std::ptr::null(), offset, length)
}

pub(super) fn progress(keys: Keys, total: u64, done: u64) -> windows::core::Result<()> {
    // SAFETY: plain values; Windows ignores a key that no longer names a request.
    unsafe { CfReportProviderProgress(keys.connection, keys.transfer, total as i64, done as i64) }
}

fn placeholders(keys: Keys, status: NTSTATUS, list: &mut [CF_PLACEHOLDER_CREATE_INFO]) -> windows::core::Result<()> {
    let ok = status == STATUS_SUCCESS;
    let data = CF_OPERATION_PARAMETERS_0_4 {
        // The listing is complete: Windows need not ask for this folder again.
        Flags: if ok {
            CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION
        } else {
            CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_NONE
        },
        CompletionStatus: status,
        PlaceholderTotalCount: list.len() as i64,
        PlaceholderArray: if list.is_empty() { std::ptr::null_mut() } else { list.as_mut_ptr() },
        PlaceholderCount: list.len() as u32,
        EntriesProcessed: 0,
    };
    execute::<CF_OPERATION_PARAMETERS_0_4>(
        keys,
        CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS,
        CF_OPERATION_PARAMETERS_0 { TransferPlaceholders: data },
    )
}

/// Answer a folder listing with all of its items.
pub(super) fn list(keys: Keys, items: &mut [CF_PLACEHOLDER_CREATE_INFO]) -> windows::core::Result<()> {
    placeholders(keys, STATUS_SUCCESS, items)
}

pub(super) fn fail_list(keys: Keys, status: NTSTATUS) -> windows::core::Result<()> {
    placeholders(keys, status, &mut [])
}

pub(super) fn ack_delete(keys: Keys, status: NTSTATUS) -> windows::core::Result<()> {
    let data = CF_OPERATION_PARAMETERS_0_7 { Flags: CF_OPERATION_ACK_DELETE_FLAG_NONE, CompletionStatus: status };
    execute::<CF_OPERATION_PARAMETERS_0_7>(
        keys,
        CF_OPERATION_TYPE_ACK_DELETE,
        CF_OPERATION_PARAMETERS_0 { AckDelete: data },
    )
}

pub(super) fn ack_rename(keys: Keys, status: NTSTATUS) -> windows::core::Result<()> {
    let data = CF_OPERATION_PARAMETERS_0_6 { Flags: CF_OPERATION_ACK_RENAME_FLAG_NONE, CompletionStatus: status };
    execute::<CF_OPERATION_PARAMETERS_0_6>(
        keys,
        CF_OPERATION_TYPE_ACK_RENAME,
        CF_OPERATION_PARAMETERS_0 { AckRename: data },
    )
}
