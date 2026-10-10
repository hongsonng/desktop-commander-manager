use chrono::Utc;
use manager_db::{DbError, EventInput, ManagerDb, SessionBinding, WorkerDescriptor};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum RouteError {
    #[error("No healthy Desktop Commander worker is available")]
    NoHealthyWorker,

    #[error("Database error: {0}")]
    Db(#[from] DbError),

    #[error("Worker error: {0}")]
    Worker(String),
}

pub use manager_protocol::RouteContext;

pub fn create_fallback_session_id(connection_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(connection_id.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("fallback:{}", &hash[..24])
}

pub trait RoutableWorkerManager: Send + Sync {
    fn get_healthy_workers(
        &self,
    ) -> impl std::future::Future<Output = Vec<WorkerDescriptor>> + Send;

    fn restart_worker(
        &self,
        id: &str,
    ) -> impl std::future::Future<Output = Result<(), RouteError>> + Send;
}

pub struct SessionRouter<M: RoutableWorkerManager> {
    db: Arc<Mutex<ManagerDb>>,
    worker_manager: Arc<M>,
    tie_cursor: AtomicUsize,
}

impl<M: RoutableWorkerManager> SessionRouter<M> {
    pub fn new(db: Arc<Mutex<ManagerDb>>, worker_manager: Arc<M>) -> Self {
        Self {
            db,
            worker_manager,
            tie_cursor: AtomicUsize::new(0),
        }
    }

    pub async fn resolve(&self, context: &RouteContext) -> Result<WorkerDescriptor, RouteError> {
        let now = Utc::now().to_rfc3339();
        let (session_id, was_fallback) = match context
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => (s.to_string(), false),
            None => (create_fallback_session_id(&context.connection_id), true),
        };

        if was_fallback {
            let db = self.db.lock().await;
            let _ = db.events().append(
                &EventInput::new(
                    "SESSION_KEY_MISSING",
                    "Using connection-scoped fallback session id",
                )
                .with_session(&session_id),
            );
        }

        let binding = {
            let db = self.db.lock().await;
            db.sessions().get(&session_id)?
        };

        if let Some(binding) = binding {
            let healthy_workers = self.worker_manager.get_healthy_workers().await;
            if let Some(healthy) = healthy_workers
                .into_iter()
                .find(|w| w.id == binding.worker_id)
            {
                let db = self.db.lock().await;
                db.sessions().upsert(&SessionBinding {
                    session_id: binding.session_id,
                    worker_id: binding.worker_id,
                    created_at: binding.created_at,
                    last_used_at: now,
                })?;
                return Ok(healthy);
            }

            // Bound worker not healthy, try restarting
            let _ = self.worker_manager.restart_worker(&binding.worker_id).await;

            let healthy_workers = self.worker_manager.get_healthy_workers().await;
            if let Some(recovered) = healthy_workers
                .into_iter()
                .find(|w| w.id == binding.worker_id)
            {
                let db = self.db.lock().await;
                db.sessions().upsert(&SessionBinding {
                    session_id: binding.session_id,
                    worker_id: binding.worker_id,
                    created_at: binding.created_at,
                    last_used_at: now,
                })?;
                return Ok(recovered);
            }

            return self.failover(&session_id, &binding.worker_id).await;
        }

        let selected = self.select_healthy(None).await?;

        // Concurrency-safe bind without holding DB lock across await
        let existing_worker_id = {
            let db = self.db.lock().await;
            if let Some(existing) = db.sessions().get(&session_id)? {
                db.sessions().upsert(&SessionBinding {
                    session_id: existing.session_id,
                    worker_id: existing.worker_id.clone(),
                    created_at: existing.created_at,
                    last_used_at: now.clone(),
                })?;
                Some(existing.worker_id)
            } else {
                db.sessions().upsert(&SessionBinding {
                    session_id: session_id.clone(),
                    worker_id: selected.id.clone(),
                    created_at: now.clone(),
                    last_used_at: now.clone(),
                })?;
                let _ = db.events().append(
                    &EventInput::new("SESSION_BOUND", format!("Bound session to {}", selected.id))
                        .with_session(&session_id)
                        .with_worker(&selected.id),
                );
                None
            }
        };

        if let Some(worker_id) = existing_worker_id {
            if worker_id == selected.id {
                return Ok(selected);
            }
            let healthy = self.worker_manager.get_healthy_workers().await;
            if let Some(w) = healthy.into_iter().find(|w| w.id == worker_id) {
                return Ok(w);
            }
        }

        Ok(selected)
    }

    pub async fn failover(
        &self,
        session_id: &str,
        failed_worker_id: &str,
    ) -> Result<WorkerDescriptor, RouteError> {
        let selected = self.select_healthy(Some(failed_worker_id)).await?;
        let now = Utc::now().to_rfc3339();
        {
            let db = self.db.lock().await;
            db.sessions().rebind(session_id, &selected.id, &now)?;
            let meta =
                serde_json::json!({ "from": failed_worker_id, "to": selected.id }).to_string();
            let _ = db.events().append(
                &EventInput::new(
                    "SESSION_FAILOVER",
                    format!("{failed_worker_id} -> {}", selected.id),
                )
                .with_session(session_id)
                .with_worker(&selected.id)
                .with_metadata(meta),
            );
        }
        Ok(selected)
    }

    pub async fn select_healthy(
        &self,
        excluded_worker_id: Option<&str>,
    ) -> Result<WorkerDescriptor, RouteError> {
        let workers = self.worker_manager.get_healthy_workers().await;
        let filtered: Vec<WorkerDescriptor> = workers
            .into_iter()
            .filter(|w| excluded_worker_id.is_none_or(|ex| w.id != ex))
            .collect();

        if filtered.is_empty() {
            return Err(RouteError::NoHealthyWorker);
        }

        let min_sessions = filtered
            .iter()
            .map(|w| w.active_session_count)
            .min()
            .unwrap();

        let by_load: Vec<WorkerDescriptor> = filtered
            .into_iter()
            .filter(|w| w.active_session_count == min_sessions)
            .collect();

        let min_failures = by_load.iter().map(|w| w.failure_count).min().unwrap();

        let mut tied: Vec<WorkerDescriptor> = by_load
            .into_iter()
            .filter(|w| w.failure_count == min_failures)
            .collect();

        tied.sort_by(|a, b| a.id.cmp(&b.id));

        if tied.len() == 1 {
            return Ok(tied.remove(0));
        }

        let cursor = self.tie_cursor.fetch_add(1, Ordering::Relaxed);
        let selected = tied.remove(cursor % tied.len());
        Ok(selected)
    }
}
