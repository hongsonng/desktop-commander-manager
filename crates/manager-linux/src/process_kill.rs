use crate::process_identity::get_process_identity;
use crate::process_table::ProcessTable;
use manager_platform::PlatformError;
use manager_protocol::{KillProcessTreeRequest, KillTreeResult};

pub fn kill_single_process(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    unsafe {
        // Send SIGKILL (signal 9)
        libc::kill(pid as libc::pid_t, libc::SIGKILL) == 0
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        false
    }
}

pub fn kill_process_tree(
    request: &KillProcessTreeRequest,
) -> Result<KillTreeResult, PlatformError> {
    // 1. Verify identity of root PID if requested
    let current_identity = get_process_identity(request.pid)?;
    let root_exists = match current_identity {
        Some(identity) => {
            if let Some(expected_time) = request.expected_creation_time_100ns {
                if identity.creation_time_100ns != expected_time {
                    return Err(PlatformError::IdentityMismatch {
                        pid: request.pid,
                        expected: expected_time,
                        actual: identity.creation_time_100ns,
                    });
                }
            }
            true
        }
        None => false,
    };

    if !root_exists {
        return Ok(KillTreeResult {
            root_pid: request.pid,
            killed_count: 0,
        });
    }

    // 2. Snapshot current process table to find descendants
    let table = ProcessTable::snapshot()?;
    let descendants = table.get_descendants(request.pid);

    let mut killed_count = 0u32;

    // 3. Terminate descendants bottom-up (reverse traversal)
    for &child_pid in descendants.iter().rev() {
        if kill_single_process(child_pid) {
            killed_count += 1;
        }
    }

    // 4. Terminate root process
    if kill_single_process(request.pid) {
        killed_count += 1;
    }

    Ok(KillTreeResult {
        root_pid: request.pid,
        killed_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kill_tree_nonexistent_pid() {
        let req = KillProcessTreeRequest {
            pid: 99999999,
            expected_creation_time_100ns: None,
        };
        let res = kill_process_tree(&req).expect("should succeed");
        assert_eq!(res.killed_count, 0);
    }
}
