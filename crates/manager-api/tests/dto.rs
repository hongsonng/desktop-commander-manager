use manager_api::dto::*;

#[test]
fn test_health_response_json_shape() {
    let health = HealthResponse {
        status: "ok".to_string(),
        started_at: "2026-09-29T00:00:00.000Z".to_string(),
        uptime_ms: 1234,
    };
    let json = serde_json::to_string(&health).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["status"], "ok");
    assert_eq!(parsed["startedAt"], "2026-09-29T00:00:00.000Z");
    assert_eq!(parsed["uptimeMs"], 1234);
}

#[test]
fn test_connection_info_json_shape() {
    let conn = ConnectionInfo::default();
    let json = serde_json::to_string(&conn).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["mode"], "direct-local");
    assert_eq!(parsed["mcpUrl"], "http://127.0.0.1:8787/mcp");
    assert_eq!(parsed["workerStrategy"], "sticky-failover");
}

#[test]
fn test_worker_descriptor_dto_json_shape() {
    let worker = WorkerDescriptorDto {
        id: "worker-1".to_string(),
        name: "worker-1".to_string(),
        enabled: true,
        status: "READY".to_string(),
        pid: Some(1234),
        failure_count: 0,
        last_heartbeat_at: Some("2026-09-29T00:00:00.000Z".to_string()),
        created_at: "2026-09-29T00:00:00.000Z".to_string(),
        updated_at: "2026-09-29T00:00:00.000Z".to_string(),
        active_session_count: 3,
    };
    let json = serde_json::to_string(&worker).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["id"], "worker-1");
    assert_eq!(parsed["name"], "worker-1");
    assert_eq!(parsed["enabled"], true);
    assert_eq!(parsed["status"], "READY");
    assert_eq!(parsed["pid"], 1234);
    assert_eq!(parsed["failureCount"], 0);
    assert_eq!(parsed["lastHeartbeatAt"], "2026-09-29T00:00:00.000Z");
    assert_eq!(parsed["createdAt"], "2026-09-29T00:00:00.000Z");
    assert_eq!(parsed["updatedAt"], "2026-09-29T00:00:00.000Z");
    assert_eq!(parsed["activeSessionCount"], 3);
}

#[test]
fn test_tool_call_dto_json_shape() {
    let tc = ToolCallDto {
        id: 42,
        session_id: Some("session-123".to_string()),
        worker_id: Some("worker-1".to_string()),
        tool_name: "execute_command".to_string(),
        status: "OK".to_string(),
        duration_ms: 42,
        args_summary: "echo hello".to_string(),
        failed_over: false,
        error: None,
        created_at: "2026-09-29T00:00:00.000Z".to_string(),
    };
    let json = serde_json::to_string(&tc).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["id"], 42);
    assert_eq!(parsed["sessionId"], "session-123");
    assert_eq!(parsed["workerId"], "worker-1");
    assert_eq!(parsed["toolName"], "execute_command");
    assert_eq!(parsed["status"], "OK");
    assert_eq!(parsed["durationMs"], 42);
    assert_eq!(parsed["argsSummary"], "echo hello");
    assert_eq!(parsed["failedOver"], false);
    assert_eq!(parsed["error"], serde_json::Value::Null);
    assert_eq!(parsed["createdAt"], "2026-09-29T00:00:00.000Z");
}

#[test]
fn test_api_error_dto_json_shape() {
    let err = ApiErrorDto {
        error: "WORKER_NOT_FOUND".to_string(),
        worker_id: Some("worker-99".to_string()),
        message: None,
    };
    let json = serde_json::to_string(&err).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["error"], "WORKER_NOT_FOUND");
    assert_eq!(parsed["workerId"], "worker-99");
    assert!(parsed.get("message").is_none());
}

#[test]
fn test_resources_dto_json_shape() {
    let res = ResourceUsageSnapshotDto {
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
    };
    let json = serde_json::to_string(&res).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["available"], true);
    assert_eq!(parsed["sampledAt"], "2026-09-29T00:00:00.000Z");
    assert_eq!(parsed["total"]["memoryBytes"], 200);
    assert_eq!(parsed["total"]["cpuPercent"], 2.0);
    assert_eq!(parsed["system"]["memoryUsedBytes"], 400);
    assert_eq!(parsed["items"][0]["id"], "manager");
    assert_eq!(parsed["items"][0]["status"], "running");
}
