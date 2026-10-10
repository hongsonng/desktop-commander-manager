use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub started_at: String,
    pub uptime_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub mode: String,
    pub mcp_url: String,
    pub worker_strategy: String,
}

impl Default for ConnectionInfo {
    fn default() -> Self {
        Self {
            mode: "direct-local".to_string(),
            mcp_url: "http://127.0.0.1:8787/mcp".to_string(),
            worker_strategy: "sticky-failover".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDescriptorDto {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub pid: Option<u32>,
    pub failure_count: u32,
    pub last_heartbeat_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub active_session_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBindingDto {
    pub session_id: String,
    pub worker_id: String,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventRecordDto {
    pub id: i64,
    pub session_id: Option<String>,
    pub worker_id: Option<String>,
    pub r#type: String,
    pub message: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallDto {
    pub id: i64,
    pub session_id: Option<String>,
    pub worker_id: Option<String>,
    pub tool_name: String,
    pub status: String,
    pub duration_ms: u64,
    pub args_summary: String,
    pub failed_over: bool,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTotalUsage {
    pub memory_bytes: u64,
    pub cpu_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSystemUsage {
    pub memory_used_bytes: u64,
    pub total_memory_bytes: u64,
    pub cpu_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProcessUsageDto {
    pub id: String,
    pub label: String,
    pub pid: Option<u32>,
    pub memory_bytes: u64,
    pub cpu_percent: f64,
    pub process_count: u32,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsageSnapshotDto {
    pub available: bool,
    pub sampled_at: String,
    pub total: ResourceTotalUsage,
    pub system: ResourceSystemUsage,
    pub items: Vec<ResourceProcessUsageDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDto {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
