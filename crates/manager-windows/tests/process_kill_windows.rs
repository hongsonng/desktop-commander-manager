use manager_platform::{PlatformError, ProcessPlatform};
use manager_protocol::KillProcessTreeRequest;
use manager_windows::WindowsProcessPlatform;
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentReady {
    parent_pid: u32,
    child_pid: u32,
}

struct TestTreeGuard {
    child: Child,
    parent_pid: u32,
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
fn test_kill_tree_identity_mismatch() {
    let platform = WindowsProcessPlatform;
    let guard = spawn_fixture_tree();

    let wrong_req = KillProcessTreeRequest {
        pid: guard.parent_pid,
        expected_creation_time_100ns: Some(42),
    };

    let result = platform.kill_tree(&wrong_req);
    assert!(
        matches!(result, Err(PlatformError::IdentityMismatch { .. })),
        "Expected IdentityMismatch error, got {:?}",
        result
    );

    // Target process must still be alive
    let identity = platform
        .identity(guard.parent_pid)
        .expect("identity call succeeded");
    assert!(identity.is_some(), "Process should NOT have been killed");
}

#[test]
fn test_kill_tree_terminates_descendants_and_leaves_sibling() {
    let platform = WindowsProcessPlatform;
    let target = spawn_fixture_tree();
    let sibling = spawn_fixture_tree();

    let target_id = platform
        .identity(target.parent_pid)
        .expect("identity call succeeded")
        .expect("target process exists");

    let kill_req = KillProcessTreeRequest {
        pid: target.parent_pid,
        expected_creation_time_100ns: Some(target_id.creation_time_100ns),
    };

    let result = platform.kill_tree(&kill_req).expect("kill_tree succeeded");
    assert_eq!(result.root_pid, target.parent_pid);
    assert!(result.killed_count >= 1);

    // Give OS time to reap terminated processes
    sleep(Duration::from_millis(200));

    // Target tree should be gone
    let target_parent_alive = platform.identity(target.parent_pid).unwrap();
    assert!(
        target_parent_alive.is_none(),
        "Target parent should be terminated"
    );

    let target_child_alive = platform.identity(target.child_pid).unwrap();
    assert!(
        target_child_alive.is_none(),
        "Target child should be terminated"
    );

    // Sibling tree must still be alive
    let sibling_parent_alive = platform.identity(sibling.parent_pid).unwrap();
    assert!(
        sibling_parent_alive.is_some(),
        "Sibling parent must still be alive"
    );

    let sibling_child_alive = platform.identity(sibling.child_pid).unwrap();
    assert!(
        sibling_child_alive.is_some(),
        "Sibling child must still be alive"
    );
}
