use crate::client::WorkerClient;
use crate::config::WorkerLaunchConfig;
use crate::error::WorkerClientError;
use crate::state::{WorkerLifecycleEvent, WorkerState, WorkerStateMachine};
use manager_platform::{ProcessPlatform, SupervisorOwnershipGuard};
use manager_protocol::{
    UpstreamFailureKind, WorkerCallToolResult, WorkerListToolsResult, WorkerStateEvent,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};

const RECOVERY_DELAYS_MS: &[u64] = &[0, 500, 1000, 2000, 5000];
const MAX_RECOVERY_ATTEMPTS: u32 = 5;

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("Worker not found: {0}")]
    WorkerNotFound(String),

    #[error("Worker is not ready: {id} (current state: {state})")]
    NotReady { id: String, state: WorkerState },

    #[error("Ownership conflict: {0}")]
    OwnershipConflict(String),

    #[error("Invalid state transition for worker {id}: {source}")]
    InvalidTransition {
        id: String,
        source: crate::state::InvalidTransition,
    },

    #[error("Worker client error: {0}")]
    Client(#[from] WorkerClientError),
}

impl SupervisorError {
    pub fn failure_kind(&self) -> UpstreamFailureKind {
        match self {
            Self::WorkerNotFound(_) => UpstreamFailureKind::PreDispatch,
            Self::NotReady { .. } => UpstreamFailureKind::PreDispatch,
            Self::OwnershipConflict(_) => UpstreamFailureKind::PreDispatch,
            Self::InvalidTransition { .. } => UpstreamFailureKind::PreDispatch,
            Self::Client(c) => c.kind(),
        }
    }
}

struct ManagedWorker {
    id: String,
    config: WorkerLaunchConfig,
    state_machine: WorkerStateMachine,
    client: Option<Arc<WorkerClient>>,
    intentional_stop: bool,
    recovery_handle: Option<tokio::task::AbortHandle>,
}

#[derive(Clone)]
pub struct WorkerSupervisor {
    workers: Arc<Mutex<HashMap<String, ManagedWorker>>>,
    platform: Option<Arc<dyn ProcessPlatform>>,
    #[allow(dead_code)]
    ownership_guard: Arc<Mutex<Option<Box<dyn SupervisorOwnershipGuard>>>>,
    event_tx: broadcast::Sender<WorkerStateEvent>,
}

impl WorkerSupervisor {
    pub fn new(
        configs: Vec<WorkerLaunchConfig>,
        platform: Option<Arc<dyn ProcessPlatform>>,
        ownership_guard: Option<Box<dyn SupervisorOwnershipGuard>>,
    ) -> Result<Self, SupervisorError> {
        if let Some(ref guard) = ownership_guard {
            if !guard.is_held() {
                return Err(SupervisorError::OwnershipConflict(
                    "Worker supervisor ownership guard is not held".to_string(),
                ));
            }
        }

        let (event_tx, _) = broadcast::channel(128);
        let mut workers = HashMap::new();

        for config in configs {
            let id = config.worker_id.clone();
            workers.insert(
                id.clone(),
                ManagedWorker {
                    id,
                    config,
                    state_machine: WorkerStateMachine::new(WorkerState::Stopped),
                    client: None,
                    intentional_stop: false,
                    recovery_handle: None,
                },
            );
        }

        Ok(Self {
            workers: Arc::new(Mutex::new(workers)),
            platform,
            ownership_guard: Arc::new(Mutex::new(ownership_guard)),
            event_tx,
        })
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<WorkerStateEvent> {
        self.event_tx.subscribe()
    }

    pub async fn get_worker_state(&self, id: &str) -> Option<WorkerState> {
        let workers = self.workers.lock().await;
        workers.get(id).map(|w| w.state_machine.state())
    }

    pub async fn get_worker_pid(&self, id: &str) -> Option<u32> {
        let workers = self.workers.lock().await;
        workers.get(id).and_then(|w| w.state_machine.pid())
    }

    pub async fn list_worker_states(&self) -> HashMap<String, (WorkerState, Option<u32>)> {
        let workers = self.workers.lock().await;
        workers
            .iter()
            .map(|(k, v)| (k.clone(), (v.state_machine.state(), v.state_machine.pid())))
            .collect()
    }

    pub async fn ensure_worker(&self, config: WorkerLaunchConfig) {
        let mut workers = self.workers.lock().await;
        let id = config.worker_id.clone();
        if let Some(existing) = workers.get_mut(&id) {
            existing.config = config;
        } else {
            workers.insert(
                id.clone(),
                ManagedWorker {
                    id,
                    config,
                    state_machine: WorkerStateMachine::new(WorkerState::Stopped),
                    client: None,
                    intentional_stop: false,
                    recovery_handle: None,
                },
            );
        }
    }

    pub async fn start_worker(&self, id: &str) -> Result<u32, SupervisorError> {
        {
            let mut workers = self.workers.lock().await;
            if let Some(worker) = workers.get_mut(id) {
                if let Some(handle) = worker.recovery_handle.take() {
                    handle.abort();
                }
            }
        }
        self.start_worker_internal(id, Duration::from_secs(10))
            .await
    }

    pub async fn start_worker_internal(
        &self,
        id: &str,
        handshake_timeout: Duration,
    ) -> Result<u32, SupervisorError> {
        let (config, platform) = {
            let mut workers = self.workers.lock().await;
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| SupervisorError::WorkerNotFound(id.to_string()))?;

            worker.intentional_stop = false;

            let prev_state = worker.state_machine.state();
            if prev_state != WorkerState::Stopped
                && prev_state != WorkerState::Degraded
                && prev_state != WorkerState::Offline
            {
                if let Some(pid) = worker.state_machine.pid() {
                    return Ok(pid);
                }
            }

            worker
                .state_machine
                .transition(WorkerLifecycleEvent::StartRequested)
                .map_err(|source| SupervisorError::InvalidTransition {
                    id: id.to_string(),
                    source,
                })?;

            self.emit_state_event(worker, Some("Starting worker".into()), None);
            (worker.config.clone(), self.platform.clone())
        };

        // Spawn child client
        let client_res = WorkerClient::spawn(config, platform).await;
        let client = match client_res {
            Ok(c) => Arc::new(c),
            Err(e) => {
                let mut workers = self.workers.lock().await;
                if let Some(worker) = workers.get_mut(id) {
                    let _ =
                        worker
                            .state_machine
                            .transition(WorkerLifecycleEvent::HandshakeFailed {
                                reason: e.to_string(),
                            });
                    self.emit_state_event(worker, Some(format!("Spawn failed: {e}")), None);
                    self.schedule_recovery_if_needed(id, worker);
                }
                return Err(SupervisorError::Client(e));
            }
        };

        let pid = client.pid();

        {
            let mut workers = self.workers.lock().await;
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| SupervisorError::WorkerNotFound(id.to_string()))?;

            worker
                .state_machine
                .transition(WorkerLifecycleEvent::Started { pid })
                .map_err(|source| SupervisorError::InvalidTransition {
                    id: id.to_string(),
                    source,
                })?;

            worker.client = Some(Arc::clone(&client));
            self.emit_state_event(worker, None, None);
        }

        // Spawn asynchronous unexpected exit monitor
        let this = self.clone();
        let worker_id_clone = id.to_string();
        let client_monitor = Arc::clone(&client);
        tokio::spawn(async move {
            let exit_code = client_monitor.wait_for_exit().await;
            this.on_worker_exit(&worker_id_clone, &client_monitor, exit_code)
                .await;
        });

        // Perform MCP Handshake
        match client.handshake(handshake_timeout).await {
            Ok(_) => {
                let mut workers = self.workers.lock().await;
                if let Some(worker) = workers.get_mut(id) {
                    worker
                        .state_machine
                        .transition(WorkerLifecycleEvent::HandshakeSucceeded)
                        .map_err(|source| SupervisorError::InvalidTransition {
                            id: id.to_string(),
                            source,
                        })?;
                    self.emit_state_event(worker, Some("Handshake ready".into()), None);
                }
                Ok(pid)
            }
            Err(e) => {
                let mut workers = self.workers.lock().await;
                if let Some(worker) = workers.get_mut(id) {
                    let _ =
                        worker
                            .state_machine
                            .transition(WorkerLifecycleEvent::HandshakeFailed {
                                reason: e.to_string(),
                            });
                    self.emit_state_event(worker, Some(format!("Handshake failed: {e}")), None);
                    self.schedule_recovery_if_needed(id, worker);
                }
                let _ = client.stop().await;
                Err(SupervisorError::Client(e))
            }
        }
    }

    pub async fn stop_worker(&self, id: &str) -> Result<(), SupervisorError> {
        let client = {
            let mut workers = self.workers.lock().await;
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| SupervisorError::WorkerNotFound(id.to_string()))?;

            if let Some(handle) = worker.recovery_handle.take() {
                handle.abort();
            }

            worker.intentional_stop = true;

            let _ = worker
                .state_machine
                .transition(WorkerLifecycleEvent::StopRequested);

            let client = worker.client.take();
            self.emit_state_event(worker, Some("Worker stopped".into()), None);
            client
        };

        if let Some(client) = client {
            let _ = client.stop().await;
        }

        Ok(())
    }

    pub async fn restart_worker(&self, id: &str) -> Result<u32, SupervisorError> {
        self.stop_worker(id).await?;
        self.start_worker(id).await
    }

    pub async fn list_tools(
        &self,
        id: &str,
        meta: Option<Value>,
        timeout: Duration,
    ) -> Result<WorkerListToolsResult, SupervisorError> {
        let client = {
            let workers = self.workers.lock().await;
            let worker = workers
                .get(id)
                .ok_or_else(|| SupervisorError::WorkerNotFound(id.to_string()))?;

            let state = worker.state_machine.state();
            if state != WorkerState::Ready && state != WorkerState::Busy {
                return Err(SupervisorError::NotReady {
                    id: id.to_string(),
                    state,
                });
            }

            worker
                .client
                .clone()
                .ok_or_else(|| SupervisorError::NotReady {
                    id: id.to_string(),
                    state,
                })?
        };

        client
            .list_tools(meta, timeout)
            .await
            .map_err(SupervisorError::Client)
    }

    pub async fn call_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Value,
        meta: Option<Value>,
        timeout: Duration,
    ) -> Result<WorkerCallToolResult, SupervisorError> {
        let client = {
            let mut workers = self.workers.lock().await;
            let worker = workers
                .get_mut(id)
                .ok_or_else(|| SupervisorError::WorkerNotFound(id.to_string()))?;

            let state = worker.state_machine.state();
            if state != WorkerState::Ready {
                return Err(SupervisorError::NotReady {
                    id: id.to_string(),
                    state,
                });
            }

            worker
                .state_machine
                .transition(WorkerLifecycleEvent::ToolCallStarted)
                .map_err(|source| SupervisorError::InvalidTransition {
                    id: id.to_string(),
                    source,
                })?;

            self.emit_state_event(worker, None, None);
            worker
                .client
                .clone()
                .ok_or_else(|| SupervisorError::NotReady {
                    id: id.to_string(),
                    state,
                })?
        };

        let result = client.call_tool(name, arguments, meta, timeout).await;

        {
            let mut workers = self.workers.lock().await;
            if let Some(worker) = workers.get_mut(id) {
                if worker.state_machine.state() == WorkerState::Busy {
                    let _ = worker
                        .state_machine
                        .transition(WorkerLifecycleEvent::ToolCallCompleted);
                    self.emit_state_event(worker, None, None);
                }
            }
        }

        result.map_err(SupervisorError::Client)
    }

    pub async fn shutdown_all(&self) -> Result<(), SupervisorError> {
        let ids: Vec<String> = {
            let workers = self.workers.lock().await;
            workers.keys().cloned().collect()
        };
        for id in ids {
            let _ = self.stop_worker(&id).await;
        }
        Ok(())
    }

    async fn on_worker_exit(
        &self,
        id: &str,
        exited_client: &Arc<WorkerClient>,
        exit_code: Option<i32>,
    ) {
        let mut workers = self.workers.lock().await;
        if let Some(worker) = workers.get_mut(id) {
            let is_current_client = worker
                .client
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, exited_client));
            if worker.intentional_stop || !is_current_client {
                return;
            }

            worker.client = None;
            let _ = worker
                .state_machine
                .transition(WorkerLifecycleEvent::ProcessExited {
                    code: exit_code,
                    signal: None,
                });

            self.emit_state_event(
                worker,
                Some("Process exited unexpectedly".into()),
                exit_code,
            );

            self.schedule_recovery_if_needed(id, worker);
        }
    }

    fn schedule_recovery_if_needed(&self, id: &str, worker: &mut ManagedWorker) {
        if worker.intentional_stop {
            return;
        }

        let failure_count = worker.state_machine.failure_count();
        if failure_count > MAX_RECOVERY_ATTEMPTS {
            let _ = worker
                .state_machine
                .transition(WorkerLifecycleEvent::RecoveryExhausted);
            self.emit_state_event(
                worker,
                Some("Recovery exhausted after maximum attempts".into()),
                None,
            );
            return;
        }

        let delay_ms = RECOVERY_DELAYS_MS
            .get(failure_count.saturating_sub(1) as usize)
            .copied()
            .unwrap_or(5000);

        let this = self.clone();
        let id_clone = id.to_string();

        let join_handle = tokio::spawn(async move {
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            let _ = this
                .start_worker_internal(&id_clone, Duration::from_secs(10))
                .await;
        });

        worker.recovery_handle = Some(join_handle.abort_handle());
    }

    fn emit_state_event(
        &self,
        worker: &ManagedWorker,
        reason: Option<String>,
        exit_code: Option<i32>,
    ) {
        let event = WorkerStateEvent {
            worker_id: worker.id.clone(),
            state: worker.state_machine.state().to_string(),
            pid: worker.state_machine.pid(),
            reason,
            exit_code,
            signal: None,
        };
        let _ = self.event_tx.send(event);
    }
}
