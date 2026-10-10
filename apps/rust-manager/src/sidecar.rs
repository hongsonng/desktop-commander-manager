use manager_platform::ProcessPlatform;
use manager_protocol::{
    SidecarEnvelope, SidecarError, SidecarEventEnvelope, SidecarMessage, SidecarReply,
    SidecarRequest, SidecarResult, UpstreamFailureKind, WorkerHandleResult,
};
use manager_windows::ownership_mutex::{
    WindowsSupervisorOwnershipGuard, DEFAULT_SUPERVISOR_MUTEX_NAME,
};
use manager_windows::WindowsProcessPlatform;
use manager_worker::{resolve_desktop_commander_spawn_spec, WorkerSupervisor};
use serde_json::Value;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub async fn run_sidecar() -> io::Result<()> {
    let platform: Arc<dyn ProcessPlatform> = Arc::new(WindowsProcessPlatform);
    let mut supervisor: Option<WorkerSupervisor> = None;
    let mut backend: Option<crate::backend::ManagerBackend> = None;

    let (stdout_tx, mut stdout_rx) = mpsc::channel::<String>(256);

    // Stdout background writer task
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = stdout_rx.recv().await {
            let _ = stdout.write_all(line.as_bytes()).await;
            let _ = stdout.write_all(b"\n").await;
            let _ = stdout.flush().await;
        }
    });

    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let reply = match serde_json::from_str::<SidecarEnvelope>(trimmed) {
            Ok(envelope) => {
                handle_envelope(
                    &platform,
                    &mut supervisor,
                    &mut backend,
                    envelope,
                    &stdout_tx,
                )
                .await
            }
            Err(err) => {
                let id = serde_json::from_str::<Value>(trimmed)
                    .ok()
                    .and_then(|v| v.get("id").and_then(|id_val| id_val.as_u64()))
                    .unwrap_or(0);

                SidecarReply {
                    id,
                    result: None,
                    error: Some(SidecarError::new(
                        "MALFORMED_REQUEST",
                        format!("Failed to parse request: {}", err),
                    )),
                }
            }
        };

        if let Ok(serialized) = serde_json::to_string(&reply) {
            let _ = stdout_tx.send(serialized).await;
        }
    }

    Ok(())
}

fn get_or_init_supervisor<'a>(
    supervisor_slot: &'a mut Option<WorkerSupervisor>,
    platform: &Arc<dyn ProcessPlatform>,
    stdout_tx: &mpsc::Sender<String>,
) -> Result<&'a WorkerSupervisor, SidecarError> {
    if supervisor_slot.is_none() {
        let root = std::env::var("DCM_RUNTIME_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("data").join("workers"));
        let base_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

        let mutex_name = std::env::var("DCM_SUPERVISOR_MUTEX_NAME")
            .unwrap_or_else(|_| DEFAULT_SUPERVISOR_MUTEX_NAME.to_string());
        let guard = match WindowsSupervisorOwnershipGuard::acquire(&mutex_name) {
            Ok(g) => Box::new(g),
            Err(e) => {
                return Err(SidecarError::with_failure_kind(
                    "OWNERSHIP_CONFLICT",
                    format!("Failed to acquire worker supervisor ownership mutex: {e}"),
                    UpstreamFailureKind::PreDispatch,
                ));
            }
        };

        let mut configs = Vec::new();
        for worker_id in &["worker-1", "worker-2"] {
            let worker_runtime = root.join(worker_id);
            if let Ok(cfg) =
                resolve_desktop_commander_spawn_spec(worker_id, &worker_runtime, &base_dir)
            {
                configs.push(cfg);
            }
        }

        let supervisor = WorkerSupervisor::new(configs, Some(Arc::clone(platform)), Some(guard))
            .map_err(|e| {
                SidecarError::with_failure_kind(
                    "SUPERVISOR_INIT_FAILED",
                    e.to_string(),
                    UpstreamFailureKind::PreDispatch,
                )
            })?;

        // Background worker state event streamer
        let mut event_rx = supervisor.subscribe_events();
        let event_tx = stdout_tx.clone();
        tokio::spawn(async move {
            while let Ok(event) = event_rx.recv().await {
                let envelope = SidecarEventEnvelope::WorkerStateChanged(event);
                let msg = SidecarMessage::Event(envelope);
                if let Ok(serialized) = serde_json::to_string(&msg) {
                    let _ = event_tx.send(serialized).await;
                }
            }
        });

        *supervisor_slot = Some(supervisor);
    }

    Ok(supervisor_slot.as_ref().unwrap())
}

async fn handle_envelope(
    platform: &Arc<dyn ProcessPlatform>,
    supervisor: &mut Option<WorkerSupervisor>,
    backend: &mut Option<crate::backend::ManagerBackend>,
    envelope: SidecarEnvelope,
    stdout_tx: &mpsc::Sender<String>,
) -> SidecarReply {
    match envelope.request {
        SidecarRequest::ProcessSnapshot(req) => match platform.snapshot(&req) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::Snapshot(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::ProcessIdentity(req) => match platform.identity(req.pid) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::Identity(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::KillProcessTree(req) => match platform.kill_tree(&req) {
            Ok(res) => SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::KillTree(res)),
                error: None,
            },
            Err(err) => SidecarReply {
                id: envelope.id,
                result: None,
                error: Some(SidecarError::new("PLATFORM_ERROR", err.to_string())),
            },
        },
        SidecarRequest::WorkerStart(req) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            if !req.command.is_empty() && !req.runtime_dir.is_empty() {
                let cfg = manager_worker::WorkerLaunchConfig::new(
                    &req.worker_id,
                    PathBuf::from(&req.command),
                    req.args,
                    req.env,
                    PathBuf::from(&req.runtime_dir),
                );
                sup.ensure_worker(cfg).await;
            }
            match sup.start_worker(&req.worker_id).await {
                Ok(pid) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::WorkerHandle(WorkerHandleResult {
                        worker_id: req.worker_id,
                        pid,
                    })),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::WorkerStop(req) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            match sup.stop_worker(&req.worker_id).await {
                Ok(()) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::WorkerHandle(WorkerHandleResult {
                        worker_id: req.worker_id,
                        pid: 0,
                    })),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::WorkerRestart(req) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            match sup.restart_worker(&req.worker_id).await {
                Ok(pid) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::WorkerHandle(WorkerHandleResult {
                        worker_id: req.worker_id,
                        pid,
                    })),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::WorkerListTools(req) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            match sup
                .list_tools(&req.worker_id, req.meta, Duration::from_secs(10))
                .await
            {
                Ok(res) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::ListTools(res)),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::WorkerCallTool(req) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            match sup
                .call_tool(
                    &req.worker_id,
                    &req.name,
                    req.arguments,
                    req.meta,
                    Duration::from_secs(30),
                )
                .await
            {
                Ok(res) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::CallTool(res)),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::WorkerShutdownAll(_) => {
            let sup = match get_or_init_supervisor(supervisor, platform, stdout_tx) {
                Ok(s) => s,
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(e),
                    }
                }
            };
            match sup.shutdown_all().await {
                Ok(()) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::Empty(serde_json::json!({}))),
                    error: None,
                },
                Err(err) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(SidecarError::with_failure_kind(
                        "WORKER_ERROR",
                        err.to_string(),
                        err.failure_kind(),
                    )),
                },
            }
        }
        SidecarRequest::BackendOpen(req) => {
            let mutex_name = std::env::var("DCM_SUPERVISOR_MUTEX_NAME")
                .unwrap_or_else(|_| DEFAULT_SUPERVISOR_MUTEX_NAME.to_string());
            let guard = match WindowsSupervisorOwnershipGuard::acquire(&mutex_name) {
                Ok(g) => Box::new(g),
                Err(e) => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::with_failure_kind(
                            "OWNERSHIP_CONFLICT",
                            format!("Failed to acquire worker supervisor ownership mutex: {e}"),
                            UpstreamFailureKind::PreDispatch,
                        )),
                    };
                }
            };

            match crate::backend::ManagerBackend::open(
                &PathBuf::from(&req.database_path),
                &PathBuf::from(&req.runtime_root),
                Arc::clone(platform),
                guard,
                stdout_tx.clone(),
            )
            .await
            {
                Ok(b) => {
                    *backend = Some(b);
                    SidecarReply {
                        id: envelope.id,
                        result: Some(SidecarResult::Empty(serde_json::json!({ "opened": true }))),
                        error: None,
                    }
                }
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::BackendClose(_) => {
            if let Some(b) = backend.take() {
                let _ = b.close().await;
            }
            SidecarReply {
                id: envelope.id,
                result: Some(SidecarResult::Empty(serde_json::json!({ "closed": true }))),
                error: None,
            }
        }
        SidecarRequest::ProxyListTools(req) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.list_tools(req).await {
                Ok(res) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::ProxyListTools(res)),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::ProxyCallTool(req) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.call_tool(req).await {
                Ok(res) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::ProxyCallTool(res)),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::StateGetWorker(req) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.get_worker(&req.worker_id).await {
                Ok(worker) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::StateGetWorker(
                        manager_protocol::StateGetWorkerResult { worker },
                    )),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::StateListWorkers(_) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.list_workers().await {
                Ok(workers) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::StateListWorkers(
                        manager_protocol::StateListWorkersResult { workers },
                    )),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::StateListSessions(_) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.list_sessions().await {
                Ok(sessions) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::StateListSessions(
                        manager_protocol::StateListSessionsResult { sessions },
                    )),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::StateListEvents(req) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.list_events(req.limit).await {
                Ok(events) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::StateListEvents(
                        manager_protocol::StateListEventsResult { events },
                    )),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
        SidecarRequest::StateAppendEvent(req) => {
            let b = match backend.as_ref() {
                Some(b) => b,
                None => {
                    return SidecarReply {
                        id: envelope.id,
                        result: None,
                        error: Some(SidecarError::new(
                            "BACKEND_NOT_OPEN",
                            "Backend is not open. Call backend/open first.",
                        )),
                    }
                }
            };
            match b.append_event(req.event).await {
                Ok(event) => SidecarReply {
                    id: envelope.id,
                    result: Some(SidecarResult::StateAppendEvent(
                        manager_protocol::StateAppendEventResult { event },
                    )),
                    error: None,
                },
                Err(e) => SidecarReply {
                    id: envelope.id,
                    result: None,
                    error: Some(e),
                },
            }
        }
    }
}
