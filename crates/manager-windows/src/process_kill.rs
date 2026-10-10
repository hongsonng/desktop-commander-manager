use crate::process_identity::get_process_identity;
use crate::process_table::ProcessTable;
use manager_platform::PlatformError;
use manager_protocol::{KillProcessTreeRequest, KillTreeResult};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

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
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, child_pid);
            if !handle.is_null() {
                if TerminateProcess(handle, 1) != 0 {
                    killed_count += 1;
                }
                CloseHandle(handle);
            }
        }
    }

    // 4. Terminate root process
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, request.pid);
        if !handle.is_null() {
            if TerminateProcess(handle, 1) != 0 {
                killed_count += 1;
            }
            CloseHandle(handle);
        }
    }

    Ok(KillTreeResult {
        root_pid: request.pid,
        killed_count,
    })
}
