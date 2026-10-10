use chrono::Utc;
use manager_api::dto::{
    ResourceProcessUsageDto, ResourceSystemUsage, ResourceTotalUsage, ResourceUsageSnapshotDto,
};
use manager_api::routes::create_router;
use manager_api::state::{ApiState, BoxFuture, ResourceProvider, WorkerActions};
use manager_db::{ManagerDb, WorkerStatus};
use manager_platform::{ProcessPlatform, ProcessSnapshotRequest};
use manager_worker::WorkerSupervisor;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

pub struct RunningServer {
    pub url: String,
    shutdown_tx: oneshot::Sender<()>,
}

#[derive(Default, Clone)]
pub struct ManagementServerManager {
    inner: Arc<Mutex<Option<RunningServer>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManagementServerError {
    #[error("MANAGEMENT_ALREADY_RUNNING: Management server is already running")]
    AlreadyRunning,
    #[error("MANAGEMENT_BIND_FAILED: Failed to bind listener on {0}:{1}: {2}")]
    Bind(String, u16, std::io::Error),
}

impl ManagementServerManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        &self,
        host: &str,
        port: u16,
        state: ApiState,
    ) -> Result<String, ManagementServerError> {
        let mut slot = self.inner.lock().await;
        if slot.is_some() {
            return Err(ManagementServerError::AlreadyRunning);
        }

        let addr_str = format!("{}:{}", host, port);
        let listener = TcpListener::bind(&addr_str)
            .await
            .map_err(|e| ManagementServerError::Bind(host.to_string(), port, e))?;

        let local_addr = listener
            .local_addr()
            .map_err(|e| ManagementServerError::Bind(host.to_string(), port, e))?;
        let actual_port = local_addr.port();
        let url = format!("http://{}:{}", host, actual_port);

        let router = create_router(state);
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        *slot = Some(RunningServer {
            url: url.clone(),
            shutdown_tx,
        });

        Ok(url)
    }

    pub async fn stop(&self) -> bool {
        let mut slot = self.inner.lock().await;
        if let Some(server) = slot.take() {
            let _ = server.shutdown_tx.send(());
            true
        } else {
            false
        }
    }

    pub async fn get_url(&self) -> Option<String> {
        let slot = self.inner.lock().await;
        slot.as_ref().map(|s| s.url.clone())
    }
}

pub struct BackendWorkerActions {
    supervisor: Arc<WorkerSupervisor>,
    db: Arc<Mutex<ManagerDb>>,
}

impl BackendWorkerActions {
    pub fn new(supervisor: Arc<WorkerSupervisor>, db: Arc<Mutex<ManagerDb>>) -> Self {
        Self { supervisor, db }
    }
}

impl WorkerActions for BackendWorkerActions {
    fn restart<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let supervisor = self.supervisor.clone();
        let db = self.db.clone();
        let wid = worker_id.to_string();
        Box::pin(async move {
            {
                let db_guard = db.lock().await;
                if let Ok(Some(mut w)) = db_guard.workers().get(&wid) {
                    w.enabled = true;
                    let _ = db_guard.workers().upsert(&w);
                }
            }
            supervisor
                .restart_worker(&wid)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }

    fn enable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let supervisor = self.supervisor.clone();
        let db = self.db.clone();
        let wid = worker_id.to_string();
        Box::pin(async move {
            {
                let db_guard = db.lock().await;
                if let Ok(Some(mut w)) = db_guard.workers().get(&wid) {
                    w.enabled = true;
                    let _ = db_guard.workers().upsert(&w);
                }
            }
            let _ = supervisor.start_worker(&wid).await;
            Ok(())
        })
    }

    fn disable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let supervisor = self.supervisor.clone();
        let db = self.db.clone();
        let wid = worker_id.to_string();
        Box::pin(async move {
            let _ = supervisor.stop_worker(&wid).await;
            {
                let db_guard = db.lock().await;
                if let Ok(Some(mut w)) = db_guard.workers().get(&wid) {
                    w.enabled = false;
                    w.status = WorkerStatus::Disabled;
                    w.pid = None;
                    let _ = db_guard.workers().upsert(&w);
                }
            }
            Ok(())
        })
    }
}

#[cfg(windows)]
fn read_system_memory() -> (u64, u64) {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut status) != 0 {
            let total = status.ullTotalPhys;
            let used = status.ullTotalPhys.saturating_sub(status.ullAvailPhys);
            (used, total)
        } else {
            (0, 0)
        }
    }
}

#[cfg(not(windows))]
fn read_system_memory() -> (u64, u64) {
    (0, 0)
}

#[cfg(windows)]
fn read_system_cpu_ticks() -> Option<(u64, u64)> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetSystemTimes;
    unsafe {
        let mut idle: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
            let idle_ticks = ((idle.dwHighDateTime as u64) << 32) | (idle.dwLowDateTime as u64);
            let kernel_ticks =
                ((kernel.dwHighDateTime as u64) << 32) | (kernel.dwLowDateTime as u64);
            let user_ticks = ((user.dwHighDateTime as u64) << 32) | (user.dwLowDateTime as u64);
            let total_ticks = kernel_ticks + user_ticks;
            Some((idle_ticks, total_ticks))
        } else {
            None
        }
    }
}

#[cfg(not(windows))]
fn read_system_cpu_ticks() -> Option<(u64, u64)> {
    None
}

struct ResourceSamplerState {
    previous_at: Instant,
    previous_cpu: HashMap<String, f64>,
    previous_system_ticks: Option<(u64, u64)>,
}

pub struct PlatformResourceProvider {
    platform: Arc<dyn ProcessPlatform>,
    db: Arc<Mutex<ManagerDb>>,
    manager_pid: u32,
    tunnel_profile: String,
    state: Mutex<ResourceSamplerState>,
}

impl PlatformResourceProvider {
    pub fn new(
        platform: Arc<dyn ProcessPlatform>,
        db: Arc<Mutex<ManagerDb>>,
        manager_pid: u32,
    ) -> Self {
        Self {
            platform,
            db,
            manager_pid,
            tunnel_profile: "default".to_string(),
            state: Mutex::new(ResourceSamplerState {
                previous_at: Instant::now(),
                previous_cpu: HashMap::new(),
                previous_system_ticks: read_system_cpu_ticks(),
            }),
        }
    }
}

impl ResourceProvider for PlatformResourceProvider {
    fn snapshot<'a>(&'a self) -> BoxFuture<'a, ResourceUsageSnapshotDto> {
        Box::pin(async move {
            let sampled_at = Utc::now().to_rfc3339();
            let (mem_used, mem_total) = read_system_memory();

            let workers = {
                let db = self.db.lock().await;
                db.workers().list().unwrap_or_default()
            };
            let worker_pids: Vec<u32> = workers.iter().filter_map(|w| w.pid).collect();

            let req = ProcessSnapshotRequest {
                manager_pid: self.manager_pid,
                worker_pids: worker_pids.clone(),
                tunnel_profile: self.tunnel_profile.clone(),
            };

            let raw = match self.platform.snapshot(&req) {
                Ok(r) => r,
                Err(e) => {
                    return ResourceUsageSnapshotDto {
                        available: false,
                        sampled_at,
                        total: ResourceTotalUsage {
                            memory_bytes: 0,
                            cpu_percent: 0.0,
                        },
                        system: ResourceSystemUsage {
                            memory_used_bytes: mem_used,
                            total_memory_bytes: mem_total,
                            cpu_percent: 0.0,
                        },
                        items: vec![ResourceProcessUsageDto {
                            id: "manager".to_string(),
                            label: "Manager".to_string(),
                            pid: Some(self.manager_pid),
                            memory_bytes: 0,
                            cpu_percent: 0.0,
                            process_count: 1,
                            status: "running".to_string(),
                        }],
                        error: Some(e.to_string()),
                    };
                }
            };

            let now = Instant::now();
            let mut state = self.state.lock().await;
            let elapsed_seconds = now
                .duration_since(state.previous_at)
                .as_secs_f64()
                .max(0.001);
            let logical_processors = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1)
                .max(1) as f64;

            let mut calculate_cpu = |id: &str, cpu_seconds: f64| -> f64 {
                let prev = state.previous_cpu.get(id).copied();
                state.previous_cpu.insert(id.to_string(), cpu_seconds);
                match prev {
                    Some(p) if cpu_seconds >= p => {
                        let pct =
                            ((cpu_seconds - p) / (elapsed_seconds * logical_processors)) * 100.0;
                        ((pct * 100.0).round() / 100.0).clamp(0.0, 100.0)
                    }
                    _ => 0.0,
                }
            };

            let mut items = Vec::new();

            // Manager
            let mgr_cpu = calculate_cpu("manager", raw.manager.cpu_seconds);
            items.push(ResourceProcessUsageDto {
                id: "manager".to_string(),
                label: "Manager".to_string(),
                pid: raw.manager.root_pid,
                memory_bytes: raw.manager.memory_bytes,
                cpu_percent: mgr_cpu,
                process_count: raw.manager.process_count,
                status: if raw.manager.process_count > 0 {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                },
            });

            // Tunnel
            let tun_cpu = calculate_cpu("tunnel", raw.tunnel.cpu_seconds);
            items.push(ResourceProcessUsageDto {
                id: "tunnel".to_string(),
                label: "Secure MCP Tunnel".to_string(),
                pid: raw.tunnel.root_pid,
                memory_bytes: raw.tunnel.memory_bytes,
                cpu_percent: tun_cpu,
                process_count: raw.tunnel.process_count,
                status: if raw.tunnel.process_count > 0 {
                    "running".to_string()
                } else {
                    "stopped".to_string()
                },
            });

            // Map workers by root_pid
            let raw_workers_by_pid: HashMap<u32, &manager_protocol::ProcessUsage> = raw
                .workers
                .iter()
                .filter_map(|w| w.root_pid.map(|pid| (pid, w)))
                .collect();

            for worker in workers {
                let usage = worker
                    .pid
                    .and_then(|pid| raw_workers_by_pid.get(&pid).copied());
                let (mem, cpu_sec, count) = match usage {
                    Some(u) => (u.memory_bytes, u.cpu_seconds, u.process_count),
                    None => (0, 0.0, 0),
                };
                let w_cpu = calculate_cpu(&worker.id, cpu_sec);
                items.push(ResourceProcessUsageDto {
                    id: worker.id.clone(),
                    label: worker.name,
                    pid: worker.pid,
                    memory_bytes: mem,
                    cpu_percent: w_cpu,
                    process_count: count,
                    status: if count > 0 {
                        "running".to_string()
                    } else {
                        "stopped".to_string()
                    },
                });
            }

            // System CPU
            let current_system = read_system_cpu_ticks();
            let mut system_cpu_percent = 0.0;
            if let (Some((cur_idle, cur_total)), Some((prev_idle, prev_total))) =
                (current_system, state.previous_system_ticks)
            {
                let total_delta = cur_total.saturating_sub(prev_total);
                let idle_delta = cur_idle.saturating_sub(prev_idle);
                if total_delta > 0 {
                    let busy_delta = total_delta.saturating_sub(idle_delta);
                    let pct = (busy_delta as f64 / total_delta as f64) * 100.0;
                    system_cpu_percent = ((pct * 100.0).round() / 100.0).clamp(0.0, 100.0);
                }
            }
            state.previous_system_ticks = current_system;
            state.previous_at = now;

            let total_memory: u64 = items.iter().map(|i| i.memory_bytes).sum();
            let total_cpu: f64 = {
                let sum: f64 = items.iter().map(|i| i.cpu_percent).sum();
                ((sum * 100.0).round() / 100.0).clamp(0.0, 100.0)
            };

            ResourceUsageSnapshotDto {
                available: true,
                sampled_at,
                total: ResourceTotalUsage {
                    memory_bytes: total_memory,
                    cpu_percent: total_cpu,
                },
                system: ResourceSystemUsage {
                    memory_used_bytes: mem_used,
                    total_memory_bytes: mem_total,
                    cpu_percent: system_cpu_percent,
                },
                items,
                error: None,
            }
        })
    }
}
