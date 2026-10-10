use manager_platform::PlatformError;
use std::collections::{HashMap, HashSet, VecDeque};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

#[derive(Debug, Clone)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

#[derive(Debug, Default, Clone)]
pub struct ProcessTable {
    pub processes: HashMap<u32, ProcessEntry>,
    pub children_by_parent: HashMap<u32, Vec<u32>>,
}

impl ProcessTable {
    pub fn snapshot() -> Result<Self, PlatformError> {
        let snapshot_handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot_handle == INVALID_HANDLE_VALUE {
            return Err(PlatformError::Internal(
                "CreateToolhelp32Snapshot failed".to_string(),
            ));
        }

        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut processes = HashMap::new();
        let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();

        unsafe {
            let mut success = Process32FirstW(snapshot_handle, &mut entry);
            while success != 0 {
                let pid = entry.th32ProcessID;
                let parent_pid = entry.th32ParentProcessID;

                let name_len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);

                processes.insert(
                    pid,
                    ProcessEntry {
                        pid,
                        parent_pid,
                        name,
                    },
                );

                children_by_parent.entry(parent_pid).or_default().push(pid);

                success = Process32NextW(snapshot_handle, &mut entry);
            }

            CloseHandle(snapshot_handle);
        }

        Ok(Self {
            processes,
            children_by_parent,
        })
    }

    pub fn get_descendants(&self, root_pid: u32) -> Vec<u32> {
        let mut descendants = Vec::new();
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();

        visited.insert(root_pid);
        queue.push_back(root_pid);

        while let Some(current) = queue.pop_front() {
            if let Some(children) = self.children_by_parent.get(&current) {
                for &child_pid in children {
                    if visited.insert(child_pid) {
                        descendants.push(child_pid);
                        queue.push_back(child_pid);
                    }
                }
            }
        }

        descendants
    }

    pub fn get_tree(&self, root_pid: u32) -> Vec<u32> {
        if !self.processes.contains_key(&root_pid) {
            return Vec::new();
        }

        let mut tree = vec![root_pid];
        tree.extend(self.get_descendants(root_pid));
        tree
    }

    pub fn find_pids_by_name(&self, target_name: &str) -> Vec<u32> {
        let target_lower = target_name.to_lowercase();
        self.processes
            .values()
            .filter(|e| e.name.to_lowercase() == target_lower)
            .map(|e| e.pid)
            .collect()
    }
}
