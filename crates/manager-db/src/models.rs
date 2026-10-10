use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkerStatus {
    #[default]
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

impl std::fmt::Display for WorkerStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl rusqlite::ToSql for WorkerStatus {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::from(self.as_str()))
    }
}

impl rusqlite::types::FromSql for WorkerStatus {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let s = value.as_str()?;
        Ok(Self::from_str_lossy(s))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct WorkerDescriptor {
    #[serde(flatten)]
    pub record: WorkerRecord,
    pub active_session_count: usize,
}

impl std::ops::Deref for WorkerDescriptor {
    type Target = WorkerRecord;
    fn deref(&self) -> &Self::Target {
        &self.record
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub session_id: String,
    pub worker_id: String,
    pub created_at: String,
    pub last_used_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: i64,
    pub session_id: Option<String>,
    pub worker_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub message: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub session_id: Option<String>,
    pub worker_id: Option<String>,
    #[serde(rename = "type")]
    pub event_type: String,
    pub message: String,
    pub metadata_json: Option<String>,
    #[serde(default = "default_now")]
    pub created_at: String,
}

fn default_now() -> String {
    Utc::now().to_rfc3339()
}

impl EventInput {
    pub fn new(event_type: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            session_id: None,
            worker_id: None,
            event_type: event_type.into(),
            message: message.into(),
            metadata_json: None,
            created_at: Utc::now().to_rfc3339(),
        }
    }

    pub fn with_session(mut self, session_id: impl Into<String>) -> Self {
        self.session_id = Some(session_id.into());
        self
    }

    pub fn with_worker(mut self, worker_id: impl Into<String>) -> Self {
        self.worker_id = Some(worker_id.into());
        self
    }

    pub fn with_metadata(mut self, metadata_json: impl Into<String>) -> Self {
        self.metadata_json = Some(metadata_json.into());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkerStatePatch {
    pub status: WorkerStatus,
    pub pid: Option<Option<u32>>,
    pub failure_count: Option<u32>,
    pub last_heartbeat_at: Option<Option<String>>,
}

impl WorkerStatePatch {
    pub fn new(status: WorkerStatus) -> Self {
        Self {
            status,
            pid: None,
            failure_count: None,
            last_heartbeat_at: None,
        }
    }

    pub fn with_pid(mut self, pid: Option<u32>) -> Self {
        self.pid = Some(pid);
        self
    }

    pub fn with_failure_count(mut self, failure_count: u32) -> Self {
        self.failure_count = Some(failure_count);
        self
    }

    pub fn with_last_heartbeat_at(mut self, last_heartbeat_at: Option<String>) -> Self {
        self.last_heartbeat_at = Some(last_heartbeat_at);
        self
    }
}
