use crate::actions::{disable_worker, enable_worker, restart_worker};
use crate::dto::*;
use crate::state::{ApiState, DefaultResourceProvider, ResourceProvider};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

pub fn create_router(state: ApiState) -> Router {
    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/connection", get(connection_handler))
        .route("/api/workers", get(workers_handler))
        .route("/api/workers/{id}/restart", post(restart_worker))
        .route("/api/workers/{id}/enable", post(enable_worker))
        .route("/api/workers/{id}/disable", post(disable_worker))
        .route("/api/resources", get(resources_handler))
        .route("/api/sessions", get(sessions_handler))
        .route("/api/events", get(events_handler))
        .route("/api/tool-calls", get(tool_calls_handler))
        .with_state(state)
}

async fn health_handler(State(state): State<ApiState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        started_at: state.started_at_iso.clone(),
        uptime_ms: state.started_at.elapsed().as_millis() as u64,
    })
}

async fn connection_handler(State(state): State<ApiState>) -> Json<ConnectionInfo> {
    Json(state.connection_info.clone())
}

async fn workers_handler(
    State(state): State<ApiState>,
) -> Result<Json<Vec<WorkerDescriptorDto>>, (StatusCode, Json<ApiErrorDto>)> {
    let db = state.db.lock().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_LOCK_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let workers = db.workers().list().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_QUERY_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let mut result = Vec::with_capacity(workers.len());
    for w in workers {
        let active_count = db.sessions().count_by_worker(&w.id).unwrap_or(0) as u32;
        result.push(WorkerDescriptorDto {
            id: w.id,
            name: w.name,
            enabled: w.enabled,
            status: w.status.as_str().to_string(),
            pid: w.pid,
            failure_count: w.failure_count,
            last_heartbeat_at: w.last_heartbeat_at,
            created_at: w.created_at,
            updated_at: w.updated_at,
            active_session_count: active_count,
        });
    }

    Ok(Json(result))
}

async fn resources_handler(State(state): State<ApiState>) -> Json<ResourceUsageSnapshotDto> {
    if let Some(ref provider) = state.resource_provider {
        Json(provider.snapshot().await)
    } else {
        Json(DefaultResourceProvider.snapshot().await)
    }
}

async fn sessions_handler(
    State(state): State<ApiState>,
) -> Result<Json<Vec<SessionBindingDto>>, (StatusCode, Json<ApiErrorDto>)> {
    let db = state.db.lock().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_LOCK_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let sessions = db.sessions().list().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_QUERY_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let result = sessions
        .into_iter()
        .map(|s| SessionBindingDto {
            session_id: s.session_id,
            worker_id: s.worker_id,
            created_at: s.created_at,
            last_used_at: s.last_used_at,
        })
        .collect();

    Ok(Json(result))
}

async fn events_handler(
    State(state): State<ApiState>,
) -> Result<Json<Vec<EventRecordDto>>, (StatusCode, Json<ApiErrorDto>)> {
    let db = state.db.lock().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_LOCK_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let events = db.events().list(Some(200)).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_QUERY_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let result = events
        .into_iter()
        .filter(|e| e.event_type != "TOOL_CALL")
        .take(100)
        .map(|e| EventRecordDto {
            id: e.id,
            session_id: e.session_id,
            worker_id: e.worker_id,
            r#type: e.event_type,
            message: e.message,
            metadata_json: e.metadata_json,
            created_at: e.created_at,
        })
        .collect();

    Ok(Json(result))
}

async fn tool_calls_handler(
    State(state): State<ApiState>,
) -> Result<Json<Vec<ToolCallDto>>, (StatusCode, Json<ApiErrorDto>)> {
    let db = state.db.lock().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_LOCK_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let events = db.events().list(Some(500)).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_QUERY_ERROR".to_string(),
                worker_id: None,
                message: Some(e.to_string()),
            }),
        )
    })?;

    let result = events
        .into_iter()
        .filter(|e| e.event_type == "TOOL_CALL")
        .take(100)
        .map(|e| {
            let meta: Option<Value> = e
                .metadata_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok());

            let tool_name = meta
                .as_ref()
                .and_then(|m| m.get("toolName"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    e.message
                        .split_whitespace()
                        .next()
                        .unwrap_or("unknown")
                        .to_string()
                });

            let args_summary = meta
                .as_ref()
                .and_then(|m| m.get("argsSummary"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let status = meta
                .as_ref()
                .and_then(|m| m.get("status"))
                .and_then(|v| v.as_str())
                .map(|s| if s == "ERROR" { "ERROR" } else { "OK" })
                .unwrap_or("OK")
                .to_string();

            let duration_ms = meta
                .as_ref()
                .and_then(|m| m.get("durationMs"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            let failed_over = meta
                .as_ref()
                .and_then(|m| m.get("failedOver"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let error = meta
                .as_ref()
                .and_then(|m| m.get("error"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            ToolCallDto {
                id: e.id,
                session_id: e.session_id,
                worker_id: e.worker_id,
                tool_name,
                args_summary,
                status,
                duration_ms,
                failed_over,
                error,
                created_at: e.created_at,
            }
        })
        .collect();

    Ok(Json(result))
}
