use manager_platform::*;

struct FakePlatform;

impl ProcessPlatform for FakePlatform {
    fn snapshot(
        &self,
        request: &ProcessSnapshotRequest,
    ) -> Result<ProcessSnapshotResult, PlatformError> {
        Ok(ProcessSnapshotResult {
            manager: ProcessUsage {
                root_pid: Some(request.manager_pid),
                memory_bytes: 1024,
                cpu_seconds: 0.1,
                process_count: 1,
            },
            tunnel: ProcessUsage {
                root_pid: None,
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 0,
            },
            workers: vec![],
            diagnostics: vec![],
        })
    }

    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
        if pid == 999 {
            return Ok(None);
        }
        Ok(Some(ProcessIdentity {
            pid,
            creation_time_100ns: 123456789,
            image_path: Some("fake.exe".to_string()),
        }))
    }

    fn kill_tree(&self, request: &KillProcessTreeRequest) -> Result<KillTreeResult, PlatformError> {
        if request.pid == 999 {
            return Err(PlatformError::ProcessNotFound(999));
        }
        Ok(KillTreeResult {
            root_pid: request.pid,
            killed_count: 1,
        })
    }
}

#[test]
fn fake_platform_implements_contract() {
    let platform = FakePlatform;
    let req = ProcessSnapshotRequest {
        manager_pid: 100,
        worker_pids: vec![],
        tunnel_profile: "test".to_string(),
    };
    let snap = platform.snapshot(&req).expect("snapshot");
    assert_eq!(snap.manager.root_pid, Some(100));

    let id = platform.identity(100).expect("identity");
    assert!(id.is_some());

    let missing = platform.identity(999).expect("identity missing");
    assert!(missing.is_none());

    let kill = platform
        .kill_tree(&KillProcessTreeRequest {
            pid: 100,
            expected_creation_time_100ns: None,
        })
        .expect("kill");
    assert_eq!(kill.killed_count, 1);
}
