use manager_platform::{PlatformError, ProcessIdentity};
use std::fs;
use std::path::Path;

pub fn parse_stat_starttime(stat_str: &str) -> Option<u64> {
    let close_paren = stat_str.rfind(')')?;
    let rest = &stat_str[close_paren + 1..].trim_start();
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    // tokens[0] is state (field 3)
    // tokens[1] is ppid (field 4)
    // tokens[19] is starttime (field 22)
    if tokens.len() > 19 {
        tokens[19].parse::<u64>().ok()
    } else {
        None
    }
}

pub fn get_process_identity(pid: u32) -> Result<Option<ProcessIdentity>, PlatformError> {
    get_process_identity_with_proc_dir(pid, Path::new("/proc"))
}

pub fn get_process_identity_with_proc_dir(
    pid: u32,
    proc_dir: &Path,
) -> Result<Option<ProcessIdentity>, PlatformError> {
    let stat_file = proc_dir.join(pid.to_string()).join("stat");
    let content = match fs::read_to_string(&stat_file) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Err(PlatformError::AccessDenied(pid, e.to_string()))
        }
        Err(e) => return Err(PlatformError::Internal(e.to_string())),
    };

    let starttime = parse_stat_starttime(&content).unwrap_or(0);

    let exe_link = proc_dir.join(pid.to_string()).join("exe");
    let image_path = fs::read_link(&exe_link)
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    Ok(Some(ProcessIdentity {
        pid,
        creation_time_100ns: starttime,
        image_path,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_stat_starttime() {
        let sample = "1234 (test process (sub)) S 1000 1234 1234 0 -1 4194304 123 0 0 0 10 5 0 0 20 0 1 0 987654 2000000 500";
        let starttime = parse_stat_starttime(sample);
        assert_eq!(starttime, Some(987654));
    }
}
