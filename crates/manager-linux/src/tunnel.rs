use crate::process_metrics::measure_tree;
use crate::process_table::ProcessTable;
use manager_protocol::ProcessUsage;
use std::fs;

pub fn read_process_command_line(pid: u32) -> Result<String, String> {
    let path = format!("/proc/{pid}/cmdline");
    let bytes =
        fs::read(&path).map_err(|e| format!("Failed to read cmdline for PID {pid}: {e}"))?;
    let replaced: Vec<u8> = bytes
        .into_iter()
        .map(|b| if b == 0 { b' ' } else { b })
        .collect();
    Ok(String::from_utf8_lossy(&replaced).to_string())
}

pub fn inspect_tunnel(table: &ProcessTable, tunnel_profile: &str) -> (ProcessUsage, Vec<String>) {
    let mut candidate_pids = table.find_pids_by_name("tunnel-client");
    if candidate_pids.is_empty() {
        candidate_pids.extend(table.find_pids_by_name("secure-mcp-tunnel"));
    }
    if candidate_pids.is_empty() {
        candidate_pids.extend(table.find_pids_by_name("cloudflared"));
    }

    if candidate_pids.is_empty() {
        return (
            ProcessUsage {
                root_pid: None,
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 0,
            },
            Vec::new(),
        );
    }

    let mut diagnostics = Vec::new();
    let mut matched_pids = Vec::new();

    for pid in candidate_pids {
        match read_process_command_line(pid) {
            Ok(cmd_line) => {
                if cmd_line.contains("--profile") && cmd_line.contains(tunnel_profile) {
                    matched_pids.push(pid);
                }
            }
            Err(err) => {
                diagnostics.push(format!(
                    "Failed to verify tunnel-client candidate PID {}: {}",
                    pid, err
                ));
            }
        }
    }

    if matched_pids.len() == 1 {
        let matched_pid = matched_pids[0];
        let usage = measure_tree(table, matched_pid);
        (usage, diagnostics)
    } else {
        if matched_pids.len() > 1 {
            diagnostics.push(format!(
                "Multiple tunnel-client processes matched profile '{}': {:?}",
                tunnel_profile, matched_pids
            ));
        }
        (
            ProcessUsage {
                root_pid: None,
                memory_bytes: 0,
                cpu_seconds: 0.0,
                process_count: 0,
            },
            diagnostics,
        )
    }
}
