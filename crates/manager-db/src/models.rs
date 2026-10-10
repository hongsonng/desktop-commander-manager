use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkerStatus {
    Stopped,
    Starting,
    Ready,
    Busy,
    Degraded,
    Disabled,
    Offline,
}

impl WorkerStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkerStatus::Stopped => "STOPPED",
            WorkerStatus::Starting => "STARTING",
            WorkerStatus::Ready => "READY",
            WorkerStatus::Busy => "BUSY",
            WorkerStatus::Degraded => "DEGRADED",
            WorkerStatus::Disabled => "DISABLED",
            WorkerStatus::Offline => "OFFLINE",
        }
    }

    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "STOPPED" => WorkerStatus::Stopped,
            "STARTING" => WorkerStatus::Starting,
            "READY" => WorkerStatus::Ready,
            "BUSY" => WorkerStatus::Busy,
            "DEGRADED" => WorkerStatus::Degraded,
            "DISABLED" => WorkerStatus::Disabled,
            "OFFLINE" => WorkerStatus::Offline,
            _ => WorkerStatus::Degraded,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerRecord {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub status: WorkerStatus,
    pub pid: Option<u32>,
    pub failure_count: u32,
    pub last_heartbeat_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionBinding {
    pub session_id: String,
    pub worker_id: String,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRecord {
    pub id: i64,
    pub session_id: Option<String>,
    pub worker_id: Option<String>,
    pub event_type: String,
    pub message: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
}
