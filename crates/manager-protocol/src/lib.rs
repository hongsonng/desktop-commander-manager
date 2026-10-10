use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: SidecarRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
pub enum SidecarRequest {
    #[serde(rename = "process/snapshot")]
    ProcessSnapshot(ProcessSnapshotRequest),

    #[serde(rename = "process/identity")]
    ProcessIdentity(ProcessIdentityRequest),

    #[serde(rename = "process/killTree")]
    KillProcessTree(KillProcessTreeRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshotRequest {
    pub manager_pid: u32,
    pub worker_pids: Vec<u32>,
    pub tunnel_profile: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentityRequest {
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillProcessTreeRequest {
    pub pid: u32,
    #[serde(default)]
    pub expected_creation_time_100ns: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarReply {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<SidecarResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SidecarError>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SidecarResult {
    Snapshot(ProcessSnapshotResult),
    Identity(Option<ProcessIdentity>),
    KillTree(KillTreeResult),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    pub root_pid: Option<u32>,
    pub memory_bytes: u64,
    pub cpu_seconds: f64,
    pub process_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshotResult {
    pub manager: ProcessUsage,
    pub tunnel: ProcessUsage,
    pub workers: Vec<ProcessUsage>,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub creation_time_100ns: u64,
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTreeResult {
    pub root_pid: u32,
    pub killed_count: u32,
}
