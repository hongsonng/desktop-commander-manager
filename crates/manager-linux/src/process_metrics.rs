use crate::process_table::ProcessTable;
use manager_protocol::ProcessUsage;
use std::fs;
use std::path::Path;

pub fn get_page_size() -> u64 {
    #[cfg(target_os = "linux")]
    unsafe {
        let ps = libc::sysconf(libc::_SC_PAGESIZE);
        if ps > 0 {
            return ps as u64;
        }
    }
    4096
}

pub fn get_clk_tck() -> f64 {
    #[cfg(target_os = "linux")]
    unsafe {
        let tck = libc::sysconf(libc::_SC_CLK_TCK);
        if tck > 0 {
            return tck as f64;
        }
    }
    100.0
}

pub fn sample_process_metrics(pid: u32) -> Option<(u64, f64)> {
    sample_process_metrics_with_proc_dir(pid, Path::new("/proc"))
}

pub fn sample_process_metrics_with_proc_dir(pid: u32, proc_dir: &Path) -> Option<(u64, f64)> {
    let pid_dir = proc_dir.join(pid.to_string());
    if !pid_dir.exists() {
        return None;
    }

    // 1. Read memory from /proc/[pid]/statm
    let statm_path = pid_dir.join("statm");
    let memory_bytes = if let Ok(statm_content) = fs::read_to_string(&statm_path) {
        let tokens: Vec<&str> = statm_content.split_whitespace().collect();
        // tokens[1] is resident pages
        if let Some(resident_pages_str) = tokens.get(1) {
            let pages = resident_pages_str.parse::<u64>().unwrap_or(0);
            pages * get_page_size()
        } else {
            0
        }
    } else {
        0
    };

    // 2. Read CPU time from /proc/[pid]/stat
    let stat_path = pid_dir.join("stat");
    let cpu_seconds = if let Ok(stat_content) = fs::read_to_string(&stat_path) {
        if let Some(close_paren) = stat_content.rfind(')') {
            let rest = &stat_content[close_paren + 1..].trim_start();
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            // tokens[11] is utime (field 14)
            // tokens[12] is stime (field 15)
            let utime = tokens
                .get(11)
                .and_then(|t| t.parse::<u64>().ok())
                .unwrap_or(0);
            let stime = tokens
                .get(12)
                .and_then(|t| t.parse::<u64>().ok())
                .unwrap_or(0);
            (utime + stime) as f64 / get_clk_tck()
        } else {
            0.0
        }
    } else {
        0.0
    };

    Some((memory_bytes, cpu_seconds))
}

pub fn measure_process(pid: u32) -> ProcessUsage {
    if let Some((mem, cpu)) = sample_process_metrics(pid) {
        ProcessUsage {
            root_pid: Some(pid),
            memory_bytes: mem,
            cpu_seconds: cpu,
            process_count: 1,
        }
    } else {
        ProcessUsage {
            root_pid: Some(pid),
            memory_bytes: 0,
            cpu_seconds: 0.0,
            process_count: 0,
        }
    }
}

pub fn measure_tree(table: &ProcessTable, root_pid: u32) -> ProcessUsage {
    measure_tree_with_proc_dir(table, root_pid, Path::new("/proc"))
}

pub fn measure_tree_with_proc_dir(
    table: &ProcessTable,
    root_pid: u32,
    proc_dir: &Path,
) -> ProcessUsage {
    let pids = table.get_tree(root_pid);
    if pids.is_empty() {
        return ProcessUsage {
            root_pid: Some(root_pid),
            memory_bytes: 0,
            cpu_seconds: 0.0,
            process_count: 0,
        };
    }

    let mut total_memory = 0u64;
    let mut total_cpu = 0.0f64;
    let mut count = 0u32;

    for pid in pids {
        if let Some((mem, cpu)) = sample_process_metrics_with_proc_dir(pid, proc_dir) {
            total_memory = total_memory.saturating_add(mem);
            total_cpu += cpu;
            count += 1;
        }
    }

    ProcessUsage {
        root_pid: Some(root_pid),
        memory_bytes: total_memory,
        cpu_seconds: total_cpu,
        process_count: count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sample_metrics_from_mock_dir() {
        let temp = tempfile::tempdir().unwrap();
        let pid_dir = temp.path().join("999");
        fs::create_dir_all(&pid_dir).unwrap();

        fs::write(pid_dir.join("statm"), "1000 250 50 10 0 20 0").unwrap();
        fs::write(
            pid_dir.join("stat"),
            "999 (worker) S 1 999 999 0 -1 4194304 0 0 0 0 200 100 0 0 20 0 1 0 100 200000 250",
        )
        .unwrap();

        let metrics = sample_process_metrics_with_proc_dir(999, temp.path());
        assert!(metrics.is_some());
        let (mem, cpu) = metrics.unwrap();
        assert_eq!(mem, 250 * 4096);
        assert!((cpu - 3.0).abs() < 0.01);
    }
}
