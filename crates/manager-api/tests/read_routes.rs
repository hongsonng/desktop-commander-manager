use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use manager_api::dto::*;
use manager_api::routes::create_router;
use manager_api::state::{ApiState, BoxFuture, ResourceProvider};
use manager_db::{EventInput, ManagerDb, SessionBinding, WorkerRecord, WorkerStatus};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

struct FakeResourceProvider;

impl ResourceProvider for FakeResourceProvider {
    fn snapshot<'a>(&'a self) -> BoxFuture<'a, ResourceUsageSnapshotDto> {
        Box::pin(async {
            ResourceUsageSnapshotDto {
                available: true,
                sampled_at: "2026-09-29T00:00:00.000Z".to_string(),
                total: ResourceTotalUsage {
                    memory_bytes: 200,
                    cpu_percent: 2.0,
                },
                system: ResourceSystemUsage {
                    memory_used_bytes: 400,
                    total_memory_bytes: 16000,
                    cpu_percent: 15.0,
                },
                items: vec![ResourceProcessUsageDto {
                    id: "manager".to_string(),
                    label: "Manager".to_string(),
                    pid: Some(9999),
                    memory_bytes: 200,
                    cpu_percent: 2.0,
                    process_count: 1,
                    status: "running".to_string(),
                }],
                error: None,
            }
        })
    }
}

async fn fetch_json(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();
    (status, json)
}

#[tokio::test]
async fn test_read_routes_matching_contract() {
    let db = ManagerDb::open_in_memory().unwrap();
    let now = "2026-09-29T00:00:00.000Z".to_string();

    // 1. Seed worker-1
    db.workers()
        .upsert(&WorkerRecord {
            id: "worker-1".to_string(),
            name: "worker-1".to_string(),
            enabled: true,
            status: WorkerStatus::Ready,
            pid: Some(1234),
            failure_count: 0,
            last_heartbeat_at: Some(now.clone()),
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();

    // 2. Seed session
    db.sessions()
        .upsert(&SessionBinding {
            session_id: "session-123".to_string(),
            worker_id: "worker-1".to_string(),
            created_at: now.clone(),
            last_used_at: now.clone(),
        })
        .unwrap();

    // 3. Seed regular event
    db.events()
        .append(&EventInput {
            session_id: None,
            worker_id: Some("worker-1".to_string()),
            event_type: "READY".to_string(),
            message: "Worker ready".to_string(),
            metadata_json: None,
            created_at: now.clone(),
        })
        .unwrap();

    // 4. Seed tool call event with valid metadata
    db.events()
        .append(&EventInput {
            session_id: Some("session-123".to_string()),
            worker_id: Some("worker-1".to_string()),
            event_type: "TOOL_CALL".to_string(),
            message: "execute_command OK".to_string(),
            metadata_json: Some(
                serde_json::to_string(&serde_json::json!({
                    "toolName": "execute_command",
                    "status": "OK",
                    "durationMs": 42,
                    "argsSummary": "echo hello",
                    "failedOver": false
                }))
                .unwrap(),
            ),
            created_at: now.clone(),
        })
        .unwrap();

    // 5. Seed tool call event with malformed metadata (should degrade gracefully)
    db.events()
        .append(&EventInput {
            session_id: Some("session-123".to_string()),
            worker_id: Some("worker-1".to_string()),
            event_type: "TOOL_CALL".to_string(),
            message: "malformed_tool degraded".to_string(),
            metadata_json: Some("{ corrupt json ".to_string()),
            created_at: now.clone(),
        })
        .unwrap();

    let mut state = ApiState::new(Arc::new(Mutex::new(db)));
    state.resource_provider = Some(Arc::new(FakeResourceProvider));

    let router = create_router(state);

    // GET /api/health
    let (status, health) = fetch_json(&router, "/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["status"], "ok");
    assert!(health.get("startedAt").is_some());
    assert!(health.get("uptimeMs").is_some());

    // GET /api/connection
    let (status, conn) = fetch_json(&router, "/api/connection").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(conn["mode"], "direct-local");
    assert_eq!(conn["mcpUrl"], "http://127.0.0.1:8787/mcp");
    assert_eq!(conn["workerStrategy"], "sticky-failover");

    // GET /api/workers
    let (status, workers) = fetch_json(&router, "/api/workers").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workers.as_array().unwrap().len(), 1);
    let w1 = &workers[0];
    assert_eq!(w1["id"], "worker-1");
    assert_eq!(w1["status"], "READY");
    assert_eq!(w1["pid"], 1234);
    assert_eq!(w1["activeSessionCount"], 1);

    // GET /api/resources
    let (status, resources) = fetch_json(&router, "/api/resources").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(resources["available"], true);
    assert_eq!(resources["total"]["memoryBytes"], 200);
    assert_eq!(resources["items"][0]["id"], "manager");

    // GET /api/sessions
    let (status, sessions) = fetch_json(&router, "/api/sessions").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["sessionId"], "session-123");
    assert_eq!(sessions[0]["workerId"], "worker-1");

    // GET /api/events
    let (status, events) = fetch_json(&router, "/api/events").await;
    assert_eq!(status, StatusCode::OK);
    let events_arr = events.as_array().unwrap();
    // Only the regular non-TOOL_CALL event should be returned
    assert_eq!(events_arr.len(), 1);
    assert_eq!(events_arr[0]["type"], "READY");
    assert_eq!(events_arr[0]["workerId"], "worker-1");

    // GET /api/tool-calls
    let (status, tool_calls) = fetch_json(&router, "/api/tool-calls").await;
    assert_eq!(status, StatusCode::OK);
    let tc_arr = tool_calls.as_array().unwrap();
    assert_eq!(tc_arr.len(), 2);

    // First tool call in DESC order: id 3 was malformed_tool
    let tc_corrupt = &tc_arr[0];
    assert_eq!(tc_corrupt["toolName"], "malformed_tool");
    assert_eq!(tc_corrupt["status"], "OK");
    assert_eq!(tc_corrupt["durationMs"], 0);
    assert_eq!(tc_corrupt["argsSummary"], "");

    // Second tool call in DESC order: id 2 was execute_command
    let tc_valid = &tc_arr[1];
    assert_eq!(tc_valid["toolName"], "execute_command");
    assert_eq!(tc_valid["status"], "OK");
    assert_eq!(tc_valid["durationMs"], 42);
    assert_eq!(tc_valid["argsSummary"], "echo hello");
    assert_eq!(tc_valid["failedOver"], false);
}
