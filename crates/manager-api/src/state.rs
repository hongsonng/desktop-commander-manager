use crate::dto::{
    ConnectionInfo, ResourceSystemUsage, ResourceTotalUsage, ResourceUsageSnapshotDto,
};
use chrono::Utc;
use manager_db::ManagerDb;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ResourceProvider: Send + Sync {
    fn snapshot<'a>(&'a self) -> BoxFuture<'a, ResourceUsageSnapshotDto>;
}

pub trait WorkerActions: Send + Sync {
    fn restart<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn enable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn disable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>>;
}

pub struct DefaultResourceProvider;

impl ResourceProvider for DefaultResourceProvider {
    fn snapshot<'a>(&'a self) -> BoxFuture<'a, ResourceUsageSnapshotDto> {
        Box::pin(async {
            ResourceUsageSnapshotDto {
                available: false,
                sampled_at: Utc::now().to_rfc3339(),
                total: ResourceTotalUsage {
                    memory_bytes: 0,
                    cpu_percent: 0.0,
                },
                system: ResourceSystemUsage {
                    memory_used_bytes: 0,
                    total_memory_bytes: 0,
                    cpu_percent: 0.0,
                },
                items: Vec::new(),
                error: None,
            }
        })
    }
}

#[derive(Clone)]
pub struct ApiState {
    pub started_at: Instant,
    pub started_at_iso: String,
    pub connection_info: ConnectionInfo,
    pub db: Arc<Mutex<ManagerDb>>,
    pub resource_provider: Option<Arc<dyn ResourceProvider>>,
    pub actions: Option<Arc<dyn WorkerActions>>,
    pub dashboard_dir: Option<std::path::PathBuf>,
}

impl ApiState {
    pub fn new(db: Arc<Mutex<ManagerDb>>) -> Self {
        Self {
            started_at: Instant::now(),
            started_at_iso: Utc::now().to_rfc3339(),
            connection_info: ConnectionInfo::default(),
            db,
            resource_provider: None,
            actions: None,
            dashboard_dir: None,
        }
    }
}
