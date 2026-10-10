use manager_platform::{
    KillProcessTreeRequest, KillTreeResult, PlatformError, ProcessIdentity, ProcessPlatform,
    ProcessSnapshotRequest, ProcessSnapshotResult,
};

#[derive(Default)]
pub struct WindowsProcessPlatform;

impl ProcessPlatform for WindowsProcessPlatform {
    fn snapshot(
        &self,
        _request: &ProcessSnapshotRequest,
    ) -> Result<ProcessSnapshotResult, PlatformError> {
        Err(PlatformError::Internal("Not yet implemented".to_string()))
    }

    fn identity(&self, _pid: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
        Err(PlatformError::Internal("Not yet implemented".to_string()))
    }

    fn kill_tree(
        &self,
        _request: &KillProcessTreeRequest,
    ) -> Result<KillTreeResult, PlatformError> {
        Err(PlatformError::Internal("Not yet implemented".to_string()))
    }
}
