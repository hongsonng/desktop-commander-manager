use manager_protocol::*;

#[test]
fn roundtrip_process_snapshot_envelope() {
    let envelope = SidecarEnvelope {
        id: 42,
        request: SidecarRequest::ProcessSnapshot(ProcessSnapshotRequest {
            manager_pid: 1234,
            worker_pids: vec![5678, 9012],
            tunnel_profile: "desktop-commander-manager".to_string(),
        }),
    };

    let serialized = serde_json::to_string(&envelope).expect("serialize envelope");
    assert!(serialized.contains("\"id\":42"));
    assert!(serialized.contains("\"method\":\"process/snapshot\""));
    assert!(serialized.contains("\"managerPid\":1234"));

    let deserialized: SidecarEnvelope =
        serde_json::from_str(&serialized).expect("deserialize envelope");
    assert_eq!(envelope, deserialized);
}

#[test]
fn roundtrip_sidecar_reply_success() {
    let reply = SidecarReply {
        id: 42,
        result: Some(SidecarResult::Snapshot(ProcessSnapshotResult {
            manager: ProcessUsage {
                root_pid: Some(1234),
                memory_bytes: 1048576,
                cpu_seconds: 1.5,
                process_count: 1,
            },
            tunnel: ProcessUsage {
                root_pid: None,
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 0,
            },
            workers: vec![],
            diagnostics: vec!["tunnel not found".to_string()],
        })),
        error: None,
    };

    let serialized = serde_json::to_string(&reply).expect("serialize reply");
    let deserialized: SidecarReply = serde_json::from_str(&serialized).expect("deserialize reply");
    assert_eq!(reply, deserialized);
}

#[test]
fn roundtrip_sidecar_reply_error() {
    let reply = SidecarReply {
        id: 99,
        result: None,
        error: Some(SidecarError {
            code: "PROCESS_NOT_FOUND".to_string(),
            message: "Process 999 not found".to_string(),
        }),
    };

    let serialized = serde_json::to_string(&reply).expect("serialize error reply");
    let deserialized: SidecarReply =
        serde_json::from_str(&serialized).expect("deserialize error reply");
    assert_eq!(reply, deserialized);
}
