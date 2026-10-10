#![cfg(windows)]

use manager_platform::ProcessPlatform;
use manager_protocol::ProcessSnapshotRequest;
use manager_windows::WindowsProcessPlatform;
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentReady {
    parent_pid: u32,
    child_pid: u32,
}

struct TestTreeGuard {
    child: Child,
    parent_pid: u32,
    #[allow(dead_code)]
    child_pid: u32,
}

impl Drop for TestTreeGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn spawn_fixture_tree() -> TestTreeGuard {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_path = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests")
        .join("fixtures")
        .join("process-tree-parent.js");

    let mut cmd = Command::new("node");
    cmd.arg(&fixture_path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());

    let mut child = cmd.spawn().expect("failed to spawn fixture parent process");
    let stdout = child.stdout.take().expect("failed to take stdout");
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .expect("failed to read line from fixture");

    let ready: ParentReady =
        serde_json::from_str(&line).expect("failed to deserialize parent ready JSON");

    TestTreeGuard {
        child,
        parent_pid: ready.parent_pid,
        child_pid: ready.child_pid,
    }
}

#[test]
fn test_process_identity_live_and_exited() {
    let platform = WindowsProcessPlatform;
    let guard = spawn_fixture_tree();

    // 1. Live PID
    let live_id = platform
        .identity(guard.parent_pid)
        .expect("identity call succeeded")
        .expect("live process identity present");

    assert_eq!(live_id.pid, guard.parent_pid);
    assert!(live_id.creation_time_100ns > 0);
    assert!(
        live_id
            .image_path
            .as_ref()
            .map(|p| p.to_lowercase().contains("node"))
            .unwrap_or(false),
        "Expected image path to contain node, got {:?}",
        live_id.image_path
    );

    // 2. Non-existent PID
    let non_existent = platform
        .identity(999_999_999)
        .expect("identity call on invalid PID succeeded");
    assert!(non_existent.is_none());
}

#[test]
fn test_process_snapshot_tree() {
    let platform = WindowsProcessPlatform;
    let guard = spawn_fixture_tree();

    let current_pid = std::process::id();
    let request = ProcessSnapshotRequest {
        manager_pid: current_pid,
        worker_pids: vec![guard.parent_pid],
        tunnel_profile: "desktop-commander-manager".to_string(),
    };

    let snapshot = platform
        .snapshot(&request)
        .expect("snapshot call succeeded");

    assert_eq!(snapshot.manager.root_pid, Some(current_pid));
    assert_eq!(snapshot.manager.process_count, 1);
    assert!(snapshot.manager.memory_bytes > 0);

    assert_eq!(snapshot.workers.len(), 1);
    assert_eq!(snapshot.workers[0].root_pid, Some(guard.parent_pid));
    assert!(
        snapshot.workers[0].process_count >= 2,
        "Expected at least parent and child in worker tree, got {}",
        snapshot.workers[0].process_count
    );
    assert!(
        snapshot.workers[0].memory_bytes > 0,
        "Expected non-zero worker memory bytes"
    );
}
