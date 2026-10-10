pub mod ownership_mutex;
pub mod process_identity;
pub mod process_kill;
pub mod process_metrics;
pub mod process_table;
pub mod tunnel;

use manager_platform::{
    KillProcessTreeRequest, KillTreeResult, PlatformError, ProcessIdentity, ProcessPlatform,
    ProcessSnapshotRequest, ProcessSnapshotResult,
};
use process_identity::get_process_identity;
use process_kill::kill_process_tree;
use process_metrics::{measure_process, measure_tree};
use process_table::ProcessTable;
use tunnel::inspect_tunnel;

#[derive(Default)]
pub struct LinuxProcessPlatform;

impl ProcessPlatform for LinuxProcessPlatform {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linux_platform_implements_contract() {
        let platform = LinuxProcessPlatform;
        let req = ProcessSnapshotRequest {
            manager_pid: 1,
            tunnel_profile: "default".into(),
            worker_pids: vec![],
        };
        let snapshot = platform.snapshot(&req);
        assert!(snapshot.is_ok());
    }
}
