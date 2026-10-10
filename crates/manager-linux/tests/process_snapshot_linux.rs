use manager_linux::LinuxProcessPlatform;
use manager_platform::ProcessPlatform;
use manager_protocol::ProcessSnapshotRequest;

#[test]
fn test_linux_snapshot_runs_without_panic() {
    let platform = LinuxProcessPlatform;
    let req = ProcessSnapshotRequest {
        manager_pid: std::process::id(),
        tunnel_profile: "desktop-commander-manager".into(),
        worker_pids: vec![std::process::id()],
    };

    let result = platform.snapshot(&req).expect("snapshot should succeed");
    assert_eq!(result.manager.root_pid, Some(std::process::id()));
    assert_eq!(result.workers.len(), 1);
}
