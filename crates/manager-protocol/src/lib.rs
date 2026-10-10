pub use manager_db::{EventInput, EventRecord, SessionBinding, WorkerDescriptor, WorkerRecord};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub connection_id: String,
}

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

    #[serde(rename = "worker/start")]
    WorkerStart(WorkerStartRequest),

    #[serde(rename = "worker/stop")]
    WorkerStop(WorkerStopRequest),

    #[serde(rename = "worker/restart")]
    WorkerRestart(WorkerRestartRequest),

    #[serde(rename = "worker/listTools")]
    WorkerListTools(WorkerListToolsRequest),

    #[serde(rename = "worker/callTool")]
    WorkerCallTool(WorkerCallToolRequest),

    #[serde(rename = "worker/shutdownAll")]
    WorkerShutdownAll(WorkerShutdownAllRequest),

    // Backend and Proxy requests (M4)
    #[serde(rename = "backend/open")]
    BackendOpen(BackendOpenRequest),

    #[serde(rename = "backend/close")]
    BackendClose(BackendCloseRequest),

    #[serde(rename = "proxy/listTools")]
    ProxyListTools(ProxyListToolsRequest),

    #[serde(rename = "proxy/callTool")]
    ProxyCallTool(ProxyCallToolRequest),

    #[serde(rename = "state/getWorker")]
    StateGetWorker(StateGetWorkerRequest),

    #[serde(rename = "state/listWorkers")]
    StateListWorkers(StateListWorkersRequest),

    #[serde(rename = "state/listSessions")]
    StateListSessions(StateListSessionsRequest),

    #[serde(rename = "state/listEvents")]
    StateListEvents(StateListEventsRequest),

    #[serde(rename = "state/appendEvent")]
    StateAppendEvent(StateAppendEventRequest),

    #[serde(rename = "management/start")]
    ManagementStart(ManagementStartRequest),

    #[serde(rename = "management/stop")]
    ManagementStop(ManagementStopRequest),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendOpenRequest {
    pub database_path: String,
    pub runtime_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BackendCloseRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyListToolsRequest {
    pub context: RouteContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCallToolRequest {
    pub context: RouteContext,
    pub name: String,
    pub arguments: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateGetWorkerRequest {
    pub worker_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateListWorkersRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateListSessionsRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StateListEventsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateAppendEventRequest {
    pub event: EventInput,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStartRequest {
    pub worker_id: String,
    pub runtime_dir: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStopRequest {
    pub worker_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRestartRequest {
    pub worker_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerListToolsRequest {
    pub worker_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerCallToolRequest {
    pub worker_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkerShutdownAllRequest {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SidecarMessage {
    Reply(SidecarReply),
    Event(SidecarEventEnvelope),
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
#[serde(tag = "event", content = "params", rename_all = "camelCase")]
pub enum SidecarEventEnvelope {
    #[serde(rename = "worker/stateChanged")]
    WorkerStateChanged(WorkerStateEvent),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerStateEvent {
    pub worker_id: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SidecarResult {
    Snapshot(ProcessSnapshotResult),
    Identity(Option<ProcessIdentity>),
    KillTree(KillTreeResult),
    WorkerHandle(WorkerHandleResult),
    ListTools(WorkerListToolsResult),
    CallTool(WorkerCallToolResult),
    ProxyListTools(ProxyListToolsResult),
    ProxyCallTool(ProxyCallToolResult),
    StateGetWorker(StateGetWorkerResult),
    StateListWorkers(StateListWorkersResult),
    StateListSessions(StateListSessionsResult),
    StateListEvents(StateListEventsResult),
    StateAppendEvent(StateAppendEventResult),
    ManagementStart(ManagementStartResult),
    Empty(serde_json::Value),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementStartRequest {
    #[serde(default = "default_management_host")]
    pub host: String,
    #[serde(default = "default_management_port")]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_url: Option<String>,
}

fn default_management_host() -> String {
    "127.0.0.1".to_string()
}

fn default_management_port() -> u16 {
    8788
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManagementStopRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementStartResult {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyListToolsResult {
    pub worker_id: String,
    pub result: WorkerListToolsResult,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyCallToolResult {
    pub worker_id: String,
    pub failed_over: bool,
    pub result: WorkerCallToolResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateGetWorkerResult {
    pub worker: Option<WorkerRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateListWorkersResult {
    pub workers: Vec<WorkerDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateListSessionsResult {
    pub sessions: Vec<SessionBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateListEventsResult {
    pub events: Vec<EventRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateAppendEventResult {
    pub event: EventRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerHandleResult {
    pub worker_id: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerListToolsResult {
    pub tools: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerCallToolResult {
    pub content: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UpstreamFailureKind {
    #[serde(rename = "PRE_DISPATCH")]
    PreDispatch,
    #[serde(rename = "ACK_UNKNOWN")]
    AckUnknown,
    #[serde(rename = "UPSTREAM_ERROR")]
    UpstreamError,
    #[serde(rename = "POST_DISPATCH")]
    PostDispatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<UpstreamFailureKind>,
}

impl SidecarError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            failure_kind: None,
        }
    }

    pub fn with_failure_kind(
        code: impl Into<String>,
        message: impl Into<String>,
        failure_kind: UpstreamFailureKind,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            failure_kind: Some(failure_kind),
        }
    }
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
