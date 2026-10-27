//! The Cloud Files API (cldapi), called through Microsoft's `windows` crate: only
//! what the drive uses. Nothing here may panic or leave a request unanswered,
//! since Windows calls in from its own threads and waits on every reply.
//! Its shape follows cloud-filter by ok-nick (MIT; see LICENSE in this folder).

mod connect;
mod placeholder;
mod reply;
mod root;
mod state;

pub use connect::{Connection, Handler, Request, connect};
pub use placeholder::{Handle, Metadata, NewPlaceholder, Update, create};
pub use root::{RootSpec, active_roots, current_user_sid, is_supported, register, registered_path, unregister};
pub use state::{is_populated, mark_in_sync, state};

use windows::Win32::Foundation::{
    NTSTATUS, STATUS_CLOUD_FILE_ACCESS_DENIED, STATUS_CLOUD_FILE_INVALID_REQUEST,
    STATUS_CLOUD_FILE_NOT_UNDER_SYNC_ROOT, STATUS_CLOUD_FILE_PROVIDER_NOT_RUNNING, STATUS_CLOUD_FILE_UNSUCCESSFUL,
};

/// Why the drive turns down what Windows asked; the app that asked sees the matching error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No signed-in drive is running (the folder is being cleared with the app closed).
    NotRunning,
    Unsuccessful,
    AccessDenied,
    InvalidRequest,
    NotUnderSyncRoot,
}

impl Refusal {
    fn status(self) -> NTSTATUS {
        match self {
            Self::NotRunning => STATUS_CLOUD_FILE_PROVIDER_NOT_RUNNING,
            Self::Unsuccessful => STATUS_CLOUD_FILE_UNSUCCESSFUL,
            Self::AccessDenied => STATUS_CLOUD_FILE_ACCESS_DENIED,
            Self::InvalidRequest => STATUS_CLOUD_FILE_INVALID_REQUEST,
            Self::NotUnderSyncRoot => STATUS_CLOUD_FILE_NOT_UNDER_SYNC_ROOT,
        }
    }
}

/// A file time for Windows: 100 ns ticks since 1601.
pub type FileTime = i64;
