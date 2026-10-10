use crate::dto::{ApiErrorDto, WorkerDescriptorDto};
use crate::state::ApiState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

#[derive(Debug, Clone, Copy)]
pub enum ActionKind {
    Restart,
    Enable,
    Disable,
}

pub async fn handle_worker_action(
    state: &ApiState,
    id: &str,
    action: ActionKind,
) -> Result<Json<WorkerDescriptorDto>, (StatusCode, Json<ApiErrorDto>)> {
    // 1. Verify worker exists
    let worker_exists = {
        let db = state.db.lock().map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorDto {
                    error: "DB_LOCK_ERROR".to_string(),
                    worker_id: Some(id.to_string()),
                    message: Some(e.to_string()),
                }),
            )
        })?;

        db.workers()
            .get(id)
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiErrorDto {
                        error: "DB_QUERY_ERROR".to_string(),
                        worker_id: Some(id.to_string()),
                        message: Some(e.to_string()),
                    }),
                )
            })?
            .is_some()
    };

    if !worker_exists {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiErrorDto {
                error: "WORKER_NOT_FOUND".to_string(),
                worker_id: Some(id.to_string()),
                message: None,
            }),
        ));
    }

    // 2. Perform action if actions provider is configured
    if let Some(ref actions) = state.actions {
        let res = match action {
            ActionKind::Restart => actions.restart(id).await,
            ActionKind::Enable => actions.enable(id).await,
            ActionKind::Disable => actions.disable(id).await,
        };

        if let Err(err_msg) = res {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorDto {
                    error: "ACTION_FAILED".to_string(),
                    worker_id: Some(id.to_string()),
                    message: Some(err_msg),
                }),
            ));
        }
    }

    // 3. Return updated worker descriptor
    let db = state.db.lock().map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiErrorDto {
                error: "DB_LOCK_ERROR".to_string(),
                worker_id: Some(id.to_string()),
                message: Some(e.to_string()),
            }),
        )
    })?;

    let updated = db
        .workers()
        .get(id)
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiErrorDto {
                    error: "DB_QUERY_ERROR".to_string(),
                    worker_id: Some(id.to_string()),
                    message: Some(e.to_string()),
                }),
            )
        })?
        .ok_or_else(|| {
            (
                StatusCode::NOT_FOUND,
                Json(ApiErrorDto {
                    error: "WORKER_NOT_FOUND".to_string(),
                    worker_id: Some(id.to_string()),
                    message: None,
                }),
            )
        })?;

    let active_count = db.sessions().count_by_worker(id).unwrap_or(0) as u32;

    Ok(Json(WorkerDescriptorDto {
        id: updated.id,
        name: updated.name,
        enabled: updated.enabled,
        status: updated.status.as_str().to_string(),
        pid: updated.pid,
        failure_count: updated.failure_count,
        last_heartbeat_at: updated.last_heartbeat_at,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        active_session_count: active_count,
    }))
}

pub async fn restart_worker(
    Path(id): Path<String>,
    State(state): State<ApiState>,
) -> Result<Json<WorkerDescriptorDto>, (StatusCode, Json<ApiErrorDto>)> {
    handle_worker_action(&state, &id, ActionKind::Restart).await
}

pub async fn enable_worker(
    Path(id): Path<String>,
    State(state): State<ApiState>,
) -> Result<Json<WorkerDescriptorDto>, (StatusCode, Json<ApiErrorDto>)> {
    handle_worker_action(&state, &id, ActionKind::Enable).await
}

pub async fn disable_worker(
    Path(id): Path<String>,
    State(state): State<ApiState>,
) -> Result<Json<WorkerDescriptorDto>, (StatusCode, Json<ApiErrorDto>)> {
    handle_worker_action(&state, &id, ActionKind::Disable).await
}
