#[cfg(windows)]
pub mod ownership_mutex;
#[cfg(windows)]
pub mod process_identity;
#[cfg(windows)]
pub mod process_kill;
#[cfg(windows)]
pub mod process_metrics;
#[cfg(windows)]
pub mod process_table;
#[cfg(windows)]
pub mod tunnel;

#[cfg(windows)]
use manager_platform::{
    KillProcessTreeRequest, KillTreeResult, PlatformError, ProcessIdentity, ProcessPlatform,
    ProcessSnapshotRequest, ProcessSnapshotResult,
};
#[cfg(windows)]
use process_identity::get_process_identity;
#[cfg(windows)]
use process_kill::kill_process_tree;
#[cfg(windows)]
use process_metrics::{measure_process, measure_tree};
#[cfg(windows)]
use process_table::ProcessTable;
#[cfg(windows)]
use tunnel::inspect_tunnel;

#[cfg(windows)]
#[derive(Default)]
pub struct WindowsProcessPlatform;

#[cfg(windows)]
impl ProcessPlatform for WindowsProcessPlatform {
    fn snapshot(
        &self,
        request: &ProcessSnapshotRequest,
    ) -> Result<ProcessSnapshotResult, PlatformError> {
        let table = ProcessTable::snapshot()?;

        let manager = measure_process(request.manager_pid);

        let (tunnel, diagnostics) = inspect_tunnel(&table, &request.tunnel_profile);

        let mut workers = Vec::new();
        for &w_pid in &request.worker_pids {
            workers.push(measure_tree(&table, w_pid));
        }

        Ok(ProcessSnapshotResult {
            manager,
            tunnel,
            workers,
            diagnostics,
        })
    }

    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
        get_process_identity(pid)
    }

    fn kill_tree(&self, request: &KillProcessTreeRequest) -> Result<KillTreeResult, PlatformError> {
        kill_process_tree(request)
    }
}

#[cfg(not(windows))]
#[derive(Default)]
pub struct WindowsProcessPlatform;

#[cfg(not(windows))]
impl manager_platform::ProcessPlatform for WindowsProcessPlatform {
    fn snapshot(
        &self,
        _request: &manager_platform::ProcessSnapshotRequest,
    ) -> Result<manager_platform::ProcessSnapshotResult, manager_platform::PlatformError> {
        Err(manager_platform::PlatformError::Internal(
            "WindowsProcessPlatform is only supported on Windows".into(),
        ))
    }

    fn identity(
        &self,
        _pid: u32,
    ) -> Result<Option<manager_platform::ProcessIdentity>, manager_platform::PlatformError> {
        Err(manager_platform::PlatformError::Internal(
            "WindowsProcessPlatform is only supported on Windows".into(),
        ))
    }

    fn kill_tree(
        &self,
        _request: &manager_platform::KillProcessTreeRequest,
    ) -> Result<manager_platform::KillTreeResult, manager_platform::PlatformError> {
        Err(manager_platform::PlatformError::Internal(
            "WindowsProcessPlatform is only supported on Windows".into(),
        ))
    }
}
