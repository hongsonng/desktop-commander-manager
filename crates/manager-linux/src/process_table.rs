use manager_platform::PlatformError;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
    pub starttime: u64,
}

#[derive(Debug, Default, Clone)]
pub struct ProcessTable {
    pub processes: HashMap<u32, ProcessEntry>,
    pub children_by_parent: HashMap<u32, Vec<u32>>,
}

impl ProcessTable {
    pub fn snapshot() -> Result<Self, PlatformError> {
        Self::snapshot_from_dir(Path::new("/proc"))
    }

    pub fn snapshot_from_dir(proc_dir: &Path) -> Result<Self, PlatformError> {
        let mut processes = HashMap::new();
        let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();

        if !proc_dir.exists() {
            // If /proc does not exist (e.g. running on non-Linux system without mocked procfs), return empty table
            return Ok(Self {
                processes,
                children_by_parent,
            });
        }

        let read_dir = match fs::read_dir(proc_dir) {
            Ok(rd) => rd,
            Err(e) => {
                return Err(PlatformError::Internal(format!(
                    "Failed to read procfs: {e}"
                )))
            }
        };

        for entry in read_dir.flatten() {
            let file_name = entry.file_name();
            let name_str = file_name.to_string_lossy();
            if let Ok(pid) = name_str.parse::<u32>() {
                let stat_path = entry.path().join("stat");
                if let Ok(content) = fs::read_to_string(&stat_path) {
                    if let Some(entry) = parse_stat_line(pid, &content) {
                        children_by_parent
                            .entry(entry.parent_pid)
                            .or_default()
                            .push(pid);
                        processes.insert(pid, entry);
                    }
                }
            }
        }

        Ok(Self {
            processes,
            children_by_parent,
        })
    }

    pub fn get_descendants(&self, root_pid: u32) -> Vec<u32> {
        let mut descendants = Vec::new();
        let mut queue = VecDeque::new();
        let mut visited = HashSet::new();

        visited.insert(root_pid);
        queue.push_back(root_pid);

        while let Some(current_pid) = queue.pop_front() {
            if let Some(children) = self.children_by_parent.get(&current_pid) {
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
        let mut tree = vec![root_pid];
        tree.extend(self.get_descendants(root_pid));
        tree
    }

    pub fn find_pids_by_name(&self, target_name: &str) -> Vec<u32> {
        self.processes
            .values()
            .filter(|e| e.name.eq_ignore_ascii_case(target_name) || e.name.starts_with(target_name))
            .map(|e| e.pid)
            .collect()
    }
}

pub fn parse_stat_line(pid: u32, content: &str) -> Option<ProcessEntry> {
    let open_paren = content.find('(')?;
    let close_paren = content.rfind(')')?;
    if close_paren <= open_paren {
        return None;
    }

    let name = content[open_paren + 1..close_paren].to_string();
    let rest = &content[close_paren + 1..].trim_start();
    let tokens: Vec<&str> = rest.split_whitespace().collect();

    // tokens[0]: state
    // tokens[1]: ppid
    // tokens[19]: starttime
    let parent_pid = tokens.get(1)?.parse::<u32>().ok()?;
    let starttime = tokens
        .get(19)
        .and_then(|t| t.parse::<u64>().ok())
        .unwrap_or(0);

    Some(ProcessEntry {
        pid,
        parent_pid,
        name,
        starttime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_stat_line() {
        let sample = "456 (node worker) S 100 456 456 0 -1 4194304 123 0 0 0 10 5 0 0 20 0 1 0 112233 2000000 500";
        let entry = parse_stat_line(456, sample).expect("parse failed");
        assert_eq!(entry.pid, 456);
        assert_eq!(entry.parent_pid, 100);
        assert_eq!(entry.name, "node worker");
        assert_eq!(entry.starttime, 112233);
    }

    #[test]
    fn test_process_table_descendants() {
        let mut table = ProcessTable::default();
        table.processes.insert(
            1,
            ProcessEntry {
                pid: 1,
                parent_pid: 0,
                name: "init".into(),
                starttime: 1,
            },
        );
        table.processes.insert(
            10,
            ProcessEntry {
                pid: 10,
                parent_pid: 1,
                name: "manager".into(),
                starttime: 2,
            },
        );
        table.processes.insert(
            20,
            ProcessEntry {
                pid: 20,
                parent_pid: 10,
                name: "worker-1".into(),
                starttime: 3,
            },
        );
        table.processes.insert(
            30,
            ProcessEntry {
                pid: 30,
                parent_pid: 20,
                name: "child".into(),
                starttime: 4,
            },
        );

        table.children_by_parent.insert(1, vec![10]);
        table.children_by_parent.insert(10, vec![20]);
        table.children_by_parent.insert(20, vec![30]);

        assert_eq!(table.get_descendants(10), vec![20, 30]);
        assert_eq!(table.get_tree(10), vec![10, 20, 30]);
    }
}
