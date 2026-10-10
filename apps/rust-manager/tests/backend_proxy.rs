use manager_protocol::{
    BackendCloseRequest, BackendOpenRequest, EventInput, SidecarEnvelope, SidecarMessage,
    SidecarReply, SidecarRequest, SidecarResult, StateAppendEventRequest, StateGetWorkerRequest,
    StateListEventsRequest, StateListSessionsRequest, StateListWorkersRequest,
};
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdout, Command, Stdio};
use tempfile::tempdir;

fn read_reply(reader: &mut BufReader<ChildStdout>, expected_id: u64) -> SidecarReply {
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read line from sidecar");
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(SidecarMessage::Reply(reply)) = serde_json::from_str::<SidecarMessage>(trimmed) {
            if reply.id == expected_id {
                return reply;
            }
        }
    }
}

#[test]
fn test_backend_open_and_state_operations_via_sidecar() {
    let bin_path = env!("CARGO_BIN_EXE_dcm-manager");
    let temp_dir = tempdir().expect("temp dir");
    let db_path = temp_dir
        .path()
        .join("manager.db")
        .to_str()
        .unwrap()
        .to_string();
    let runtime_root = temp_dir
        .path()
        .join("workers")
        .to_str()
        .unwrap()
        .to_string();

    let mut child = Command::new(bin_path)
        .arg("sidecar")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .env(
            "DCM_SUPERVISOR_MUTEX_NAME",
            format!(
                "Local\\DesktopCommanderManager.TestBackend.{}",
                std::process::id()
            ),
        )
        .spawn()
        .expect("failed to spawn dcm-manager");

    let mut stdin = child.stdin.take().expect("failed to take stdin");
    let stdout = child.stdout.take().expect("failed to take stdout");
    let mut reader = BufReader::new(stdout);

    // 1. BackendOpen
    let req1 = SidecarEnvelope {
        id: 1,
        request: SidecarRequest::BackendOpen(BackendOpenRequest {
            database_path: db_path.clone(),
            runtime_root: runtime_root.clone(),
        }),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req1).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply1 = read_reply(&mut reader, 1);
    assert!(reply1.error.is_none());
    assert!(reply1.result.is_some());

    // 2. StateListWorkers -> Should have default worker-1 and worker-2
    let req2 = SidecarEnvelope {
        id: 2,
        request: SidecarRequest::StateListWorkers(StateListWorkersRequest {}),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req2).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply2 = read_reply(&mut reader, 2);
    assert!(reply2.error.is_none());
    match reply2.result {
        Some(SidecarResult::StateListWorkers(res)) => {
            assert_eq!(res.workers.len(), 2);
            assert_eq!(res.workers[0].id, "worker-1");
            assert_eq!(res.workers[1].id, "worker-2");
        }
        other => panic!("expected StateListWorkers, got: {other:?}"),
    }

    // 3. StateAppendEvent -> Append audit event
    let req3 = SidecarEnvelope {
        id: 3,
        request: SidecarRequest::StateAppendEvent(StateAppendEventRequest {
            event: EventInput::new("AUDIT_TEST", "Test audit entry").with_worker("worker-1"),
        }),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req3).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply3 = read_reply(&mut reader, 3);
    assert!(reply3.error.is_none());
    match reply3.result {
        Some(SidecarResult::StateAppendEvent(res)) => {
            assert!(res.event.id > 0);
            assert_eq!(res.event.event_type, "AUDIT_TEST");
        }
        other => panic!("expected StateAppendEvent, got: {other:?}"),
    }

    // 4. StateListEvents -> Verify appended event is in list
    let req4 = SidecarEnvelope {
        id: 4,
        request: SidecarRequest::StateListEvents(StateListEventsRequest { limit: Some(10) }),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req4).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply4 = read_reply(&mut reader, 4);
    assert!(reply4.error.is_none());
    match reply4.result {
        Some(SidecarResult::StateListEvents(res)) => {
            assert!(res.events.iter().any(|e| e.event_type == "AUDIT_TEST"));
        }
        other => panic!("expected StateListEvents, got: {other:?}"),
    }

    // 5. StateGetWorker
    let req5 = SidecarEnvelope {
        id: 5,
        request: SidecarRequest::StateGetWorker(StateGetWorkerRequest {
            worker_id: "worker-1".to_string(),
        }),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req5).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply5 = read_reply(&mut reader, 5);
    match reply5.result {
        Some(SidecarResult::StateGetWorker(res)) => {
            assert!(res.worker.is_some());
            assert_eq!(res.worker.unwrap().id, "worker-1");
        }
        other => panic!("expected StateGetWorker, got: {other:?}"),
    }

    // 6. StateListSessions -> Should be empty
    let req6 = SidecarEnvelope {
        id: 6,
        request: SidecarRequest::StateListSessions(StateListSessionsRequest {}),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req6).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply6 = read_reply(&mut reader, 6);
    match reply6.result {
        Some(SidecarResult::StateListSessions(res)) => {
            assert_eq!(res.sessions.len(), 0);
        }
        other => panic!("expected StateListSessions, got: {other:?}"),
    }

    // 7. BackendClose
    let req7 = SidecarEnvelope {
        id: 7,
        request: SidecarRequest::BackendClose(BackendCloseRequest {}),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req7).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply7 = read_reply(&mut reader, 7);
    assert!(reply7.error.is_none());

    // 8. Reopen backend: Does not duplicate workers
    let req8 = SidecarEnvelope {
        id: 8,
        request: SidecarRequest::BackendOpen(BackendOpenRequest {
            database_path: db_path,
            runtime_root,
        }),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req8).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply8 = read_reply(&mut reader, 8);
    assert!(reply8.error.is_none());

    let req9 = SidecarEnvelope {
        id: 9,
        request: SidecarRequest::StateListWorkers(StateListWorkersRequest {}),
    };
    writeln!(stdin, "{}", serde_json::to_string(&req9).unwrap()).unwrap();
    stdin.flush().unwrap();

    let reply9 = read_reply(&mut reader, 9);
    match reply9.result {
        Some(SidecarResult::StateListWorkers(res)) => {
            assert_eq!(res.workers.len(), 2);
        }
        other => panic!("expected StateListWorkers, got: {other:?}"),
    }

    // Clean exit
    drop(stdin);
    let _ = child.wait();
}
