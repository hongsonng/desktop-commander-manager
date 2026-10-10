use manager_platform::SupervisorOwnershipGuard;
use manager_worker::{SupervisorError, WorkerLaunchConfig, WorkerState, WorkerSupervisor};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn create_mock_config(id: &str, script: &str, temp_subdir: &str) -> WorkerLaunchConfig {
    let runtime_dir = std::env::temp_dir()
        .join("dcm-test-supervisor")
        .join(temp_subdir)
        .join(id);
    let _ = std::fs::remove_dir_all(&runtime_dir);
    std::fs::create_dir_all(runtime_dir.join("logs")).unwrap();

    let mut env = HashMap::new();
    for (k, v) in std::env::vars() {
        env.insert(k, v);
    }

    WorkerLaunchConfig {
        worker_id: id.into(),
        command: PathBuf::from("node"),
        args: vec!["-e".into(), script.into()],
        env,
        runtime_dir,
    }
}

struct MockOwnershipGuard {
    held: Arc<AtomicBool>,
}

impl SupervisorOwnershipGuard for MockOwnershipGuard {
    fn is_held(&self) -> bool {
        self.held.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn test_supervisor_happy_path_and_lifecycle() {
    let script = r#"
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => {
            const req = JSON.parse(line);
            if (req.method === 'initialize') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test' } }
                }));
            } else if (req.method === 'tools/list') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { tools: [{ name: 'greet' }] }
                }));
            } else if (req.method === 'tools/call') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { content: [{ type: 'text', text: 'hi ' + req.params.arguments.name }], isError: false }
                }));
            }
        });
    "#;

    let cfg1 = create_mock_config("worker-1", script, "lifecycle");
    let cfg2 = create_mock_config("worker-2", script, "lifecycle");

    let supervisor =
        WorkerSupervisor::new(vec![cfg1, cfg2], None, None).expect("create supervisor");

    let mut event_rx = supervisor.subscribe_events();

    // Start worker-1
    let pid1 = supervisor
        .start_worker("worker-1")
        .await
        .expect("start worker-1");
    assert!(pid1 > 0);
    assert_eq!(
        supervisor.get_worker_state("worker-1").await,
        Some(WorkerState::Ready)
    );

    // Call tool
    let call_res = supervisor
        .call_tool(
            "worker-1",
            "greet",
            json!({ "name": "Antigravity" }),
            None,
            Duration::from_secs(5),
        )
        .await
        .expect("call_tool");
    assert_eq!(call_res.content[0]["text"], "hi Antigravity");
    assert_eq!(
        supervisor.get_worker_state("worker-1").await,
        Some(WorkerState::Ready)
    );

    // Stop worker-1
    supervisor
        .stop_worker("worker-1")
        .await
        .expect("stop worker-1");
    assert_eq!(
        supervisor.get_worker_state("worker-1").await,
        Some(WorkerState::Stopped)
    );

    // Verify events were emitted
    let mut states = Vec::new();
    while let Ok(event) = event_rx.try_recv() {
        if event.worker_id == "worker-1" {
            states.push(event.state);
        }
    }
    assert!(states.contains(&"STARTING".to_string()));
    assert!(states.contains(&"READY".to_string()));
    assert!(states.contains(&"BUSY".to_string()));
    assert!(states.contains(&"STOPPED".to_string()));
}

#[tokio::test]
async fn test_supervisor_ownership_conflict() {
    let cfg = create_mock_config("worker-1", "process.exit(0);", "conflict");
    let guard = Box::new(MockOwnershipGuard {
        held: Arc::new(AtomicBool::new(false)),
    });

    let res = WorkerSupervisor::new(vec![cfg], None, Some(guard));
    assert!(matches!(res, Err(SupervisorError::OwnershipConflict(_))));
}

#[tokio::test]
async fn test_supervisor_crash_and_automatic_recovery() {
    // Mock server handles handshake, then crashes on a trigger tool call
    let script = r#"
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, terminal: false });
        rl.on('line', (line) => {
            const req = JSON.parse(line);
            if (req.method === 'initialize') {
                console.log(JSON.stringify({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test' } }
                }));
            } else if (req.method === 'tools/call') {
                // Die abruptly
                process.exit(101);
            }
        });
    "#;

    let cfg = create_mock_config("worker-crash", script, "recovery");
    let supervisor = WorkerSupervisor::new(vec![cfg], None, None).expect("supervisor");

    let initial_pid = supervisor
        .start_worker("worker-crash")
        .await
        .expect("start");
    assert_eq!(
        supervisor.get_worker_state("worker-crash").await,
        Some(WorkerState::Ready)
    );

    let start_time = std::time::Instant::now();

    // Trigger crash via tool call
    let _ = supervisor
        .call_tool(
            "worker-crash",
            "die",
            json!({}),
            None,
            Duration::from_secs(2),
        )
        .await;

    // Await automatic recovery back to Ready
    let mut recovered_pid = None;
    let timeout = Duration::from_secs(5);
    let deadline = tokio::time::Instant::now() + timeout;

    while tokio::time::Instant::now() < deadline {
        let state = supervisor.get_worker_state("worker-crash").await;
        let pid = supervisor.get_worker_pid("worker-crash").await;
        if state == Some(WorkerState::Ready) && pid.is_some() && pid != Some(initial_pid) {
            recovered_pid = pid;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let recovery_duration = start_time.elapsed();
    assert!(
        recovered_pid.is_some(),
        "Worker should have automatically recovered to Ready with a new PID"
    );
    assert!(
        recovery_duration < Duration::from_secs(5),
        "Worker crash recovery took {:?}, exceeding 5s gate",
        recovery_duration
    );

    // Clean up
    supervisor.stop_worker("worker-crash").await.expect("stop");
}
