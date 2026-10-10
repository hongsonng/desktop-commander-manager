use crate::error::WorkerClientError;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct WorkerLaunchConfig {
    pub worker_id: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub runtime_dir: PathBuf,
}

impl WorkerLaunchConfig {
    pub fn new(
        worker_id: impl Into<String>,
        command: impl Into<PathBuf>,
        args: Vec<String>,
        env: HashMap<String, String>,
        runtime_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            worker_id: worker_id.into(),
            command: command.into(),
            args,
            env,
            runtime_dir: runtime_dir.into(),
        }
    }
}

pub fn resolve_desktop_commander_spawn_spec(
    worker_id: &str,
    runtime_dir: &Path,
    base_dir: &Path,
) -> Result<WorkerLaunchConfig, WorkerClientError> {
    let root = runtime_dir
        .canonicalize()
        .unwrap_or_else(|_| runtime_dir.to_path_buf());
    let home = root.join("home");
    let temp = root.join("temp");
    let ps_cache = temp.join("Microsoft").join("Windows").join("PowerShell");
    let logs = root.join("logs");

    fs::create_dir_all(&home)?;
    fs::create_dir_all(&ps_cache)?;
    fs::create_dir_all(&logs)?;

    // 1. Find node_modules/@wonderwhy-er/desktop-commander/package.json
    let mut current = base_dir
        .canonicalize()
        .unwrap_or_else(|_| base_dir.to_path_buf());
    let mut pkg_json_path = None;

    loop {
        let candidate = current
            .join("node_modules")
            .join("@wonderwhy-er")
            .join("desktop-commander")
            .join("package.json");
        if candidate.exists() {
            pkg_json_path = Some(candidate);
            break;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    let pkg_json_path = pkg_json_path.ok_or_else(|| {
        WorkerClientError::pre_dispatch(
            "Could not resolve @wonderwhy-er/desktop-commander in node_modules",
        )
    })?;

    let pkg_dir = pkg_json_path.parent().unwrap();
    let pkg_content = fs::read_to_string(&pkg_json_path)?;
    let parsed: serde_json::Value = serde_json::from_str(&pkg_content)?;

    let bin_rel = if let Some(bin_str) = parsed.get("bin").and_then(|b| b.as_str()) {
        bin_str.to_string()
    } else if let Some(bin_obj) = parsed.get("bin").and_then(|b| b.as_object()) {
        bin_obj
            .get("desktop-commander")
            .or_else(|| bin_obj.values().next())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                WorkerClientError::pre_dispatch(
                    "desktop-commander package.json does not define bin",
                )
            })?
    } else {
        return Err(WorkerClientError::pre_dispatch(
            "desktop-commander package.json missing valid bin",
        ));
    };

    let bin_path = pkg_dir.join(bin_rel);
    if !bin_path.exists() {
        return Err(WorkerClientError::pre_dispatch(format!(
            "desktop-commander bin does not exist: {}",
            bin_path.display()
        )));
    }

    // Resolve node executable: check env or default to "node"
    let node_cmd = std::env::var("NODE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("node"));

    let mut env = HashMap::new();
    // Copy parent environment
    for (k, v) in std::env::vars() {
        env.insert(k, v);
    }

    let home_str = home.to_string_lossy().to_string();
    let temp_str = temp.to_string_lossy().to_string();
    let ps_cache_file = ps_cache
        .join("ModuleAnalysisCache")
        .to_string_lossy()
        .to_string();

    env.insert("USERPROFILE".into(), home_str.clone());
    env.insert("HOME".into(), home_str);
    env.insert("TEMP".into(), temp_str.clone());
    env.insert("TMP".into(), temp_str);
    env.insert("PSModuleAnalysisCachePath".into(), ps_cache_file);

    Ok(WorkerLaunchConfig {
        worker_id: worker_id.to_string(),
        command: node_cmd,
        args: vec![
            bin_path.to_string_lossy().to_string(),
            "--no-onboarding".into(),
        ],
        env,
        runtime_dir: root,
    })
}
