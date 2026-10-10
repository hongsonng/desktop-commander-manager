use manager_platform::ProcessPlatform;
#[cfg(not(any(windows, target_os = "linux")))]
use manager_platform::{PlatformError, SupervisorOwnershipGuard};
use std::sync::Arc;

#[cfg(windows)]
pub use manager_windows::ownership_mutex::WindowsSupervisorOwnershipGuard as NativeSupervisorOwnershipGuard;
#[cfg(windows)]
pub use manager_windows::ownership_mutex::DEFAULT_SUPERVISOR_MUTEX_NAME as DEFAULT_SUPERVISOR_LOCK_NAME;
#[cfg(windows)]
pub use manager_windows::WindowsProcessPlatform as NativeProcessPlatform;

#[cfg(target_os = "linux")]
pub use manager_linux::ownership_mutex::LinuxSupervisorOwnershipGuard as NativeSupervisorOwnershipGuard;
#[cfg(target_os = "linux")]
pub use manager_linux::ownership_mutex::DEFAULT_SUPERVISOR_MUTEX_NAME as DEFAULT_SUPERVISOR_LOCK_NAME;
#[cfg(target_os = "linux")]
pub use manager_linux::LinuxProcessPlatform as NativeProcessPlatform;

#[cfg(not(any(windows, target_os = "linux")))]
pub const DEFAULT_SUPERVISOR_LOCK_NAME: &str = "DesktopCommanderManager.WorkerSupervisor";

#[cfg(not(any(windows, target_os = "linux")))]
#[derive(Default)]
pub struct NativeProcessPlatform;

#[cfg(not(any(windows, target_os = "linux")))]
impl ProcessPlatform for NativeProcessPlatform {
    fn snapshot(
        &self,
        request: &manager_protocol::ProcessSnapshotRequest,
    ) -> Result<manager_protocol::ProcessSnapshotResult, PlatformError> {
        Ok(manager_protocol::ProcessSnapshotResult {
            manager: manager_protocol::ProcessUsage {
                root_pid: Some(request.manager_pid),
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 1,
            },
            tunnel: manager_protocol::ProcessUsage {
                root_pid: None,
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 0,
            },
            workers: vec![],
            diagnostics: vec![],
        })
    }

    fn identity(
        &self,
        pid: u32,
    ) -> Result<Option<manager_protocol::ProcessIdentity>, PlatformError> {
        Ok(Some(manager_protocol::ProcessIdentity {
            pid,
            creation_time_100ns: 0,
            image_path: None,
        }))
    }

    fn kill_tree(
        &self,
        request: &manager_protocol::KillProcessTreeRequest,
    ) -> Result<manager_protocol::KillTreeResult, PlatformError> {
        Ok(manager_protocol::KillTreeResult {
            root_pid: request.pid,
            killed_count: 0,
        })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub struct NativeSupervisorOwnershipGuard;

#[cfg(not(any(windows, target_os = "linux")))]
impl NativeSupervisorOwnershipGuard {
    pub fn acquire(_name: &str) -> Result<Self, PlatformError> {
        Ok(Self)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
impl SupervisorOwnershipGuard for NativeSupervisorOwnershipGuard {
    fn is_held(&self) -> bool {
        true
    }
}

pub fn create_native_platform() -> Arc<dyn ProcessPlatform> {
    Arc::new(NativeProcessPlatform)
}
