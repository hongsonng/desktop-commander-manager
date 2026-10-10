pub use manager_protocol::{
    KillProcessTreeRequest, KillTreeResult, ProcessIdentity, ProcessSnapshotRequest,
    ProcessSnapshotResult, ProcessUsage,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("Process not found: {0}")]
    ProcessNotFound(u32),

    #[error("Access denied for PID {0}: {1}")]
    AccessDenied(u32, String),

    #[error(
        "Process identity mismatch for PID {pid}: expected creation time {expected}, got {actual}"
    )]
    IdentityMismatch {
        pid: u32,
        expected: u64,
        actual: u64,
    },

    #[error("Internal platform error: {0}")]
    Internal(String),
}

pub trait ProcessPlatform: Send + Sync {
    fn snapshot(
        &self,
        request: &ProcessSnapshotRequest,
    ) -> Result<ProcessSnapshotResult, PlatformError>;
    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, PlatformError>;
    fn kill_tree(&self, request: &KillProcessTreeRequest) -> Result<KillTreeResult, PlatformError>;
}
