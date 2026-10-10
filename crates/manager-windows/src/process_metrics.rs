use crate::process_table::ProcessTable;
use manager_protocol::ProcessUsage;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_VM_READ,
};

pub fn sample_process_metrics(pid: u32) -> Option<(u64, f64)> {
    // Attempt with PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
    let handle = unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if h.is_null() {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        } else {
            h
        }
    };

    if handle.is_null() {
        return None;
    }

    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0 && exit_code != 259 {
        unsafe { CloseHandle(handle) };
        return None;
    }

    let mut memory_bytes = 0u64;
    let mut cpu_seconds = 0.0f64;

    unsafe {
        let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        let pmc_size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if GetProcessMemoryInfo(handle, &mut pmc, pmc_size) != 0 {
            memory_bytes = pmc.WorkingSetSize as u64;
        }

        let mut creation: FILETIME = std::mem::zeroed();
        let mut exit: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();

        if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
            let kernel_100ns =
                ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
            let user_100ns = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
            cpu_seconds = (kernel_100ns + user_100ns) as f64 / 10_000_000.0;
        }

        CloseHandle(handle);
    }

    Some((memory_bytes, cpu_seconds))
}

pub fn measure_tree(table: &ProcessTable, root_pid: u32) -> ProcessUsage {
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
        if let Some((mem, cpu)) = sample_process_metrics(pid) {
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
