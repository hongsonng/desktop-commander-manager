use manager_protocol::*;
use serde_json::json;
use std::collections::HashMap;

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
            failure_kind: Some(UpstreamFailureKind::PreDispatch),
        }),
    };

    let serialized = serde_json::to_string(&reply).expect("serialize error reply");
    assert!(serialized.contains("\"failureKind\":\"PRE_DISPATCH\""));
    let deserialized: SidecarReply =
        serde_json::from_str(&serialized).expect("deserialize error reply");
    assert_eq!(reply, deserialized);
}

#[test]
fn roundtrip_worker_requests() {
    let mut env = HashMap::new();
    env.insert("USERPROFILE".to_string(), "C:\\home".to_string());

    let start_req = SidecarEnvelope {
        id: 101,
        request: SidecarRequest::WorkerStart(WorkerStartRequest {
            worker_id: "worker-1".to_string(),
            runtime_dir: "C:\\workers\\1".to_string(),
            command: "node".to_string(),
            args: vec!["dist/index.js".to_string(), "--no-onboarding".to_string()],
            env,
        }),
    };

    let serialized = serde_json::to_string(&start_req).expect("serialize worker start");
    assert!(serialized.contains("\"method\":\"worker/start\""));
    assert!(serialized.contains("\"workerId\":\"worker-1\""));
    let deserialized: SidecarEnvelope = serde_json::from_str(&serialized).unwrap();
    assert_eq!(start_req, deserialized);

    let call_req = SidecarEnvelope {
        id: 102,
        request: SidecarRequest::WorkerCallTool(WorkerCallToolRequest {
            worker_id: "worker-1".to_string(),
            name: "execute_command".to_string(),
            arguments: json!({ "command": "dir" }),
            meta: Some(json!({ "progressToken": 1 })),
        }),
    };
    let call_ser = serde_json::to_string(&call_req).expect("serialize worker call");
    let call_de: SidecarEnvelope = serde_json::from_str(&call_ser).unwrap();
    assert_eq!(call_req, call_de);
}

#[test]
fn roundtrip_interleaved_events_and_replies() {
    let reply1 = SidecarMessage::Reply(SidecarReply {
        id: 1,
        result: Some(SidecarResult::WorkerHandle(WorkerHandleResult {
            worker_id: "worker-1".to_string(),
            pid: 12345,
        })),
        error: None,
    });

    let event = SidecarMessage::Event(SidecarEventEnvelope::WorkerStateChanged(WorkerStateEvent {
        worker_id: "worker-1".to_string(),
        state: "READY".to_string(),
        pid: Some(12345),
        reason: None,
        exit_code: None,
        signal: None,
    }));

    let reply2 = SidecarMessage::Reply(SidecarReply {
        id: 2,
        result: Some(SidecarResult::ListTools(WorkerListToolsResult {
            tools: vec![json!({ "name": "test_tool" })],
        })),
        error: None,
    });

    let msgs = vec![reply1, event, reply2];
    let mut lines = Vec::new();
    for msg in &msgs {
        lines.push(serde_json::to_string(msg).unwrap());
    }

    assert!(lines[1].contains("\"event\":\"worker/stateChanged\""));
    assert!(lines[1].contains("\"state\":\"READY\""));

    let deserialized: Vec<SidecarMessage> = lines
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();

    assert_eq!(msgs, deserialized);
}
