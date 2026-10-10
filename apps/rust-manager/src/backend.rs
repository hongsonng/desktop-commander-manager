use chrono::Utc;
use manager_db::{
    EventInput, EventRecord, ManagerDb, SessionBinding, WorkerDescriptor, WorkerRecord,
    WorkerStatePatch, WorkerStatus,
};
use manager_platform::{ProcessPlatform, SupervisorOwnershipGuard};
use manager_protocol::{
    ProxyCallToolRequest, ProxyCallToolResult, ProxyListToolsRequest, ProxyListToolsResult,
    SidecarError, SidecarEventEnvelope, SidecarMessage, UpstreamFailureKind,
};
use manager_router::{RetryPolicy, RoutableWorkerManager, RouteError, SessionRouter};
use manager_worker::{resolve_desktop_commander_spawn_spec, WorkerSupervisor};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

pub struct SupervisorRoutableManager {
    supervisor: Arc<WorkerSupervisor>,
    db: Arc<Mutex<ManagerDb>>,
}

impl RoutableWorkerManager for SupervisorRoutableManager {
    async fn get_healthy_workers(&self) -> Vec<WorkerDescriptor> {
        let db = self.db.lock().await;
        let workers = db.workers().list().unwrap_or_default();
        workers
            .into_iter()
            .filter(|w| {
                w.enabled && (w.status == WorkerStatus::Ready || w.status == WorkerStatus::Busy)
            })
            .map(|w| {
                let active = db.sessions().count_by_worker(&w.id).unwrap_or(0);
                WorkerDescriptor {
                    record: w,
                    active_session_count: active,
                }
            })
            .collect()
    }

    async fn restart_worker(&self, id: &str) -> Result<(), RouteError> {
        self.supervisor
            .restart_worker(id)
            .await
            .map(|_| ())
            .map_err(|e| RouteError::Worker(e.to_string()))
    }
}

pub struct ManagerBackend {
    db: Arc<Mutex<ManagerDb>>,
    supervisor: Arc<WorkerSupervisor>,
    router: SessionRouter<SupervisorRoutableManager>,
}

impl ManagerBackend {
    pub async fn open(
        database_path: &Path,
        runtime_root: &Path,
        platform: Arc<dyn ProcessPlatform>,
        guard: Box<dyn SupervisorOwnershipGuard>,
        stdout_tx: mpsc::Sender<String>,
    ) -> Result<Self, SidecarError> {
        // 1. Open and migrate SQLite database
        let db = ManagerDb::open(database_path)
            .map_err(|e| SidecarError::new("DB_OPEN_FAILED", format!("Failed to open DB: {e}")))?;

        // 2. Reconcile stale runtime state (STOPPED, pid cleared)
        db.reconcile_runtime_state().map_err(|e| {
            SidecarError::new(
                "DB_RECONCILE_FAILED",
                format!("Failed to reconcile DB: {e}"),
            )
        })?;

        // 3. Initialize default workers if database is empty
        let existing_workers = db.workers().list().map_err(|e| {
            SidecarError::new(
                "DB_LIST_WORKERS_FAILED",
                format!("Failed to list workers: {e}"),
            )
        })?;

        if existing_workers.is_empty() {
            let now = Utc::now().to_rfc3339();
            for (id, name) in &[("worker-1", "Worker 1"), ("worker-2", "Worker 2")] {
                let _ = db.workers().upsert(&WorkerRecord {
                    id: id.to_string(),
                    name: name.to_string(),
                    enabled: true,
                    status: WorkerStatus::Stopped,
                    pid: None,
                    failure_count: 0,
                    last_heartbeat_at: None,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            }
        }

        // 4. Resolve spawn configs
        let base_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut configs = Vec::new();
        for worker_id in &["worker-1", "worker-2"] {
            let worker_runtime = runtime_root.join(worker_id);
            if let Ok(cfg) =
                resolve_desktop_commander_spawn_spec(worker_id, &worker_runtime, &base_dir)
            {
                configs.push(cfg);
            }
        }

        // 5. Initialize supervisor
        let supervisor =
            WorkerSupervisor::new(configs, Some(platform), Some(guard)).map_err(|e| {
                SidecarError::with_failure_kind(
                    "SUPERVISOR_INIT_FAILED",
                    e.to_string(),
                    UpstreamFailureKind::PreDispatch,
                )
            })?;

        let supervisor = Arc::new(supervisor);
        let db = Arc::new(Mutex::new(db));

        // 6. Background worker state sync & streaming
        let mut event_rx = supervisor.subscribe_events();
        let db_sync = db.clone();
        let stream_tx = stdout_tx.clone();

        tokio::spawn(async move {
            while let Ok(event) = event_rx.recv().await {
                // Forward to Node/dashboard via stdout
                let envelope = SidecarEventEnvelope::WorkerStateChanged(event.clone());
                let msg = SidecarMessage::Event(envelope);
                if let Ok(serialized) = serde_json::to_string(&msg) {
                    let _ = stream_tx.send(serialized).await;
                }

                // Skip transient BUSY writes to keep routing fast
                if event.state == "BUSY" {
                    continue;
                }

                let mapped_status = WorkerStatus::from_str_lossy(&event.state);
                let now = Utc::now().to_rfc3339();

                let mut patch = WorkerStatePatch::new(mapped_status);
                if let Some(pid) = event.pid {
                    patch = patch.with_pid(Some(pid));
                } else if mapped_status == WorkerStatus::Stopped
                    || mapped_status == WorkerStatus::Offline
                {
                    patch = patch.with_pid(None);
                }

                if mapped_status == WorkerStatus::Ready {
                    patch = patch.with_last_heartbeat_at(Some(now.clone()));
                }

                let event_input = EventInput::new(
                    format!("WORKER_{}", event.state),
                    event.reason.clone().unwrap_or_else(|| {
                        format!("{} transitioned to {}", event.worker_id, event.state)
                    }),
                )
                .with_worker(&event.worker_id)
                .with_metadata(
                    serde_json::json!({
                        "pid": event.pid,
                        "exitCode": event.exit_code,
                    })
                    .to_string(),
                );

                let mut db_guard = db_sync.lock().await;
                let _ = db_guard.record_worker_transition(&event.worker_id, patch, &event_input);
            }
        });

        // 7. Auto-start enabled workers
        let enabled_workers: Vec<String> = {
            let db_guard = db.lock().await;
            db_guard
                .workers()
                .list()
                .unwrap_or_default()
                .into_iter()
                .filter(|w| w.enabled)
                .map(|w| w.id)
                .collect()
        };

        for worker_id in enabled_workers {
            let _ = supervisor.start_worker(&worker_id).await;
        }

        // 8. Create session router
        let routable_manager = Arc::new(SupervisorRoutableManager {
            supervisor: supervisor.clone(),
            db: db.clone(),
        });
        let router = SessionRouter::new(db.clone(), routable_manager);

        Ok(Self {
            db,
            supervisor,
            router,
        })
    }

    pub async fn list_tools(
        &self,
        req: ProxyListToolsRequest,
    ) -> Result<ProxyListToolsResult, SidecarError> {
        let worker = self
            .router
            .resolve(&req.context)
            .await
            .map_err(|e| match e {
                RouteError::NoHealthyWorker => SidecarError::with_failure_kind(
                    "NO_HEALTHY_WORKER",
                    e.to_string(),
                    UpstreamFailureKind::PreDispatch,
                ),
                other => SidecarError::new("ROUTE_ERROR", other.to_string()),
            })?;

        match self
            .supervisor
            .list_tools(&worker.id, req.meta.clone(), Duration::from_secs(30))
            .await
        {
            Ok(tools_result) => Ok(ProxyListToolsResult {
                worker_id: worker.id.clone(),
                result: tools_result,
            }),
            Err(err) => {
                let failure_kind = err.failure_kind();
                if RetryPolicy::can_replay(failure_kind) {
                    let session_id = req.context.session_id.clone().unwrap_or_else(|| {
                        manager_router::create_fallback_session_id(&req.context.connection_id)
                    });
                    let failover_worker = match self.router.failover(&session_id, &worker.id).await
                    {
                        Ok(w) => w,
                        Err(_) => {
                            return Err(SidecarError::with_failure_kind(
                                "UPSTREAM_CALL_FAILED",
                                err.to_string(),
                                failure_kind,
                            ))
                        }
                    };
                    match self
                        .supervisor
                        .list_tools(&failover_worker.id, req.meta, Duration::from_secs(30))
                        .await
                    {
                        Ok(retry_result) => Ok(ProxyListToolsResult {
                            worker_id: failover_worker.id.clone(),
                            result: retry_result,
                        }),
                        Err(err2) => Err(SidecarError::with_failure_kind(
                            "UPSTREAM_CALL_FAILED",
                            err2.to_string(),
                            err2.failure_kind(),
                        )),
                    }
                } else {
                    Err(SidecarError::with_failure_kind(
                        "UPSTREAM_CALL_FAILED",
                        err.to_string(),
                        failure_kind,
                    ))
                }
            }
        }
    }

    pub async fn call_tool(
        &self,
        req: ProxyCallToolRequest,
    ) -> Result<ProxyCallToolResult, SidecarError> {
        let worker = self
            .router
            .resolve(&req.context)
            .await
            .map_err(|e| match e {
                RouteError::NoHealthyWorker => SidecarError::with_failure_kind(
                    "NO_HEALTHY_WORKER",
                    e.to_string(),
                    UpstreamFailureKind::PreDispatch,
                ),
                other => SidecarError::new("ROUTE_ERROR", other.to_string()),
            })?;

        match self
            .supervisor
            .call_tool(
                &worker.id,
                &req.name,
                req.arguments.clone(),
                req.meta.clone(),
                Duration::from_secs(30),
            )
            .await
        {
            Ok(call_result) => Ok(ProxyCallToolResult {
                worker_id: worker.id.clone(),
                failed_over: false,
                result: call_result,
            }),
            Err(err) => {
                let failure_kind = err.failure_kind();
                if RetryPolicy::can_replay(failure_kind) {
                    let session_id = req.context.session_id.clone().unwrap_or_else(|| {
                        manager_router::create_fallback_session_id(&req.context.connection_id)
                    });
                    let failover_worker = match self.router.failover(&session_id, &worker.id).await
                    {
                        Ok(w) => w,
                        Err(_) => {
                            return Err(SidecarError::with_failure_kind(
                                "UPSTREAM_CALL_FAILED",
                                err.to_string(),
                                failure_kind,
                            ))
                        }
                    };
                    match self
                        .supervisor
                        .call_tool(
                            &failover_worker.id,
                            &req.name,
                            req.arguments,
                            req.meta,
                            Duration::from_secs(30),
                        )
                        .await
                    {
                        Ok(retry_result) => Ok(ProxyCallToolResult {
                            worker_id: failover_worker.id.clone(),
                            failed_over: true,
                            result: retry_result,
                        }),
                        Err(err2) => Err(SidecarError::with_failure_kind(
                            "UPSTREAM_CALL_FAILED",
                            err2.to_string(),
                            err2.failure_kind(),
                        )),
                    }
                } else {
                    Err(SidecarError::with_failure_kind(
                        "UPSTREAM_CALL_FAILED",
                        err.to_string(),
                        failure_kind,
                    ))
                }
            }
        }
    }

    pub async fn get_worker(&self, worker_id: &str) -> Result<Option<WorkerRecord>, SidecarError> {
        let db = self.db.lock().await;
        db.workers()
            .get(worker_id)
            .map_err(|e| SidecarError::new("DB_ERROR", e.to_string()))
    }

    pub async fn list_workers(&self) -> Result<Vec<WorkerDescriptor>, SidecarError> {
        let db = self.db.lock().await;
        let workers = db
            .workers()
            .list()
            .map_err(|e| SidecarError::new("DB_ERROR", e.to_string()))?;
        let descriptors = workers
            .into_iter()
            .map(|w| {
                let active = db.sessions().count_by_worker(&w.id).unwrap_or(0);
                WorkerDescriptor {
                    record: w,
                    active_session_count: active,
                }
            })
            .collect();
        Ok(descriptors)
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionBinding>, SidecarError> {
        let db = self.db.lock().await;
        db.sessions()
            .list()
            .map_err(|e| SidecarError::new("DB_ERROR", e.to_string()))
    }

    pub async fn list_events(
        &self,
        limit: Option<usize>,
    ) -> Result<Vec<EventRecord>, SidecarError> {
        let db = self.db.lock().await;
        db.events()
            .list(limit)
            .map_err(|e| SidecarError::new("DB_ERROR", e.to_string()))
    }

    pub async fn append_event(&self, event: EventInput) -> Result<EventRecord, SidecarError> {
        let db = self.db.lock().await;
        db.events()
            .append(&event)
            .map_err(|e| SidecarError::new("DB_ERROR", e.to_string()))
    }

    pub async fn close(&self) -> Result<(), SidecarError> {
        let _ = self.supervisor.shutdown_all().await;
        Ok(())
    }
}
