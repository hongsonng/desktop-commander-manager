use crate::process_metrics::measure_tree;
use crate::process_table::ProcessTable;
use manager_protocol::ProcessUsage;
use std::ffi::c_void;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

#[repr(C)]
struct ProcessBasicInformation {
    exit_status: i32,
    peb_base_address: *const c_void,
    affinity_mask: usize,
    base_priority: i32,
    unique_process_id: usize,
    inherited_from_unique_process_id: usize,
}

type NtQueryInformationProcessFn = unsafe extern "system" fn(
    process_handle: HANDLE,
    process_information_class: u32,
    process_information: *mut c_void,
    process_information_length: u32,
    return_length: *mut u32,
) -> i32;

pub fn read_process_command_line(pid: u32) -> Result<String, String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle.is_null() {
            return Err(format!("OpenProcess failed for PID {}", pid));
        }

        let ntdll = GetModuleHandleA(c"ntdll.dll".as_ptr() as *const u8);
        if ntdll.is_null() {
            CloseHandle(handle);
            return Err("ntdll.dll not found".to_string());
        }

        let query_proc = GetProcAddress(ntdll, c"NtQueryInformationProcess".as_ptr() as *const u8);
        let query_proc = match query_proc {
            Some(p) => p,
            None => {
                CloseHandle(handle);
                return Err("NtQueryInformationProcess not found".to_string());
            }
        };
        let query_fn: NtQueryInformationProcessFn = std::mem::transmute(query_proc);

        let mut pbi: ProcessBasicInformation = std::mem::zeroed();
        let mut ret_len = 0u32;
        let status = query_fn(
            handle,
            0, // ProcessBasicInformation
            &mut pbi as *mut _ as *mut c_void,
            std::mem::size_of::<ProcessBasicInformation>() as u32,
            &mut ret_len,
        );

        if status != 0 || pbi.peb_base_address.is_null() {
            CloseHandle(handle);
            return Err(format!(
                "NtQueryInformationProcess returned status {:#x}",
                status
            ));
        }

        // PEB offset 0x20 on x86_64: ProcessParameters (*mut c_void)
        let mut proc_params: usize = 0;
        let peb_offset_params = pbi.peb_base_address as usize + 0x20;
        let mut bytes_read = 0usize;
        if ReadProcessMemory(
            handle,
            peb_offset_params as *const c_void,
            &mut proc_params as *mut _ as *mut c_void,
            std::mem::size_of::<usize>(),
            &mut bytes_read,
        ) == 0
            || proc_params == 0
        {
            CloseHandle(handle);
            return Err("ReadProcessMemory for ProcessParameters failed".to_string());
        }

        // RTL_USER_PROCESS_PARAMETERS offset 0x70 on x86_64:
        // CommandLine: UNICODE_STRING { Length: u16, MaximumLength: u16, (padding), Buffer: *mut u16 (offset 0x78) }
        let cmd_len_offset = proc_params + 0x70;
        let mut cmd_len: u16 = 0;
        if ReadProcessMemory(
            handle,
            cmd_len_offset as *const c_void,
            &mut cmd_len as *mut _ as *mut c_void,
            std::mem::size_of::<u16>(),
            &mut bytes_read,
        ) == 0
        {
            CloseHandle(handle);
            return Err("ReadProcessMemory for CommandLine.Length failed".to_string());
        }

        let cmd_buf_offset = proc_params + 0x78;
        let mut cmd_buf_ptr: usize = 0;
        if ReadProcessMemory(
            handle,
            cmd_buf_offset as *const c_void,
            &mut cmd_buf_ptr as *mut _ as *mut c_void,
            std::mem::size_of::<usize>(),
            &mut bytes_read,
        ) == 0
            || cmd_buf_ptr == 0
        {
            CloseHandle(handle);
            return Err("ReadProcessMemory for CommandLine.Buffer failed".to_string());
        }

        if cmd_len == 0 || cmd_len > 32768 {
            CloseHandle(handle);
            return Ok(String::new());
        }

        let u16_count = (cmd_len / 2) as usize;
        let mut u16_vec = vec![0u16; u16_count];
        if ReadProcessMemory(
            handle,
            cmd_buf_ptr as *const c_void,
            u16_vec.as_mut_ptr() as *mut c_void,
            cmd_len as usize,
            &mut bytes_read,
        ) == 0
        {
            CloseHandle(handle);
            return Err("ReadProcessMemory for CommandLine buffer failed".to_string());
        }

        CloseHandle(handle);
        Ok(String::from_utf16_lossy(&u16_vec))
    }
}

pub fn inspect_tunnel(table: &ProcessTable, tunnel_profile: &str) -> (ProcessUsage, Vec<String>) {
    let candidate_pids = table.find_pids_by_name("tunnel-client.exe");
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
                // Check if command line contains profile match
                // e.g. --profile desktop-commander-manager or --profile "desktop-commander-manager"
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
