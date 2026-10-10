use manager_platform::ProcessPlatform;
use manager_protocol::{
    SidecarEnvelope, SidecarError, SidecarReply, SidecarRequest, SidecarResult,
};
use manager_windows::WindowsProcessPlatform;
use serde_json::Value;
use std::io::{self, BufRead, Write};

pub fn run_sidecar() -> io::Result<()> {
    let platform = WindowsProcessPlatform;
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[sidecar] Error reading line: {}", e);
                break;
            }
        };

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let reply = match serde_json::from_str::<SidecarEnvelope>(trimmed) {
            Ok(envelope) => handle_envelope(&platform, envelope),
            Err(err) => {
                let id = serde_json::from_str::<Value>(trimmed)
                    .ok()
                    .and_then(|v| v.get("id").and_then(|id_val| id_val.as_u64()))
                    .unwrap_or(0);

                SidecarReply {
                    id,
                    result: None,
                    error: Some(SidecarError::new(
                        "MALFORMED_REQUEST",
                        format!("Failed to parse request: {}", err),
                    )),
                }
            }
        };

        if let Ok(serialized) = serde_json::to_string(&reply) {
            let _ = stdout.write_all(serialized.as_bytes());
            let _ = stdout.write_all(b"\n");
            let _ = stdout.flush();
        }
    }

    Ok(())
}

fn handle_envelope(platform: &WindowsProcessPlatform, envelope: SidecarEnvelope) -> SidecarReply {
    match envelope.request {
        SidecarRequest::ProcessSnapshot(req) => match platform.snapshot(&req) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::Snapshot(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::ProcessIdentity(req) => match platform.identity(req.pid) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::Identity(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::KillProcessTree(req) => match platform.kill_tree(&req) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::KillTree(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::WorkerStart(_)
        | SidecarRequest::WorkerStop(_)
        | SidecarRequest::WorkerRestart(_)
        | SidecarRequest::WorkerListTools(_)
        | SidecarRequest::WorkerCallTool(_)
        | SidecarRequest::WorkerShutdownAll(_) => SidecarReply {
            id: envelope.id,
            result: None,
            error: Some(SidecarError::new(
                "NOT_IMPLEMENTED",
                "Worker runtime not yet integrated in sidecar",
            )),
        },
    }
}
