use manager_db::{ManagerDb, WorkerDescriptor, WorkerRecord, WorkerStatus};
use manager_router::{
    create_fallback_session_id, RoutableWorkerManager, RouteContext, RouteError, SessionRouter,
};
use std::sync::Arc;
use tokio::sync::Mutex;

const NOW: &str = "2026-09-29T00:00:00.000Z";

fn make_record(id: &str, failure_count: u32, status: WorkerStatus) -> WorkerRecord {
    WorkerRecord {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        status,
        pid: Some(1),
        failure_count,
        last_heartbeat_at: Some(NOW.to_string()),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

#[derive(Clone)]
enum RestartMode {
    Healthy,
    Fails,
}

struct FakeWorkerPool {
    db: Arc<Mutex<ManagerDb>>,
    restart_calls: Arc<Mutex<Vec<String>>>,
    restart_mode: Arc<Mutex<RestartMode>>,
}

impl FakeWorkerPool {
    fn new(db: Arc<Mutex<ManagerDb>>) -> Self {
        Self {
            db,
            restart_calls: Arc::new(Mutex::new(Vec::new())),
            restart_mode: Arc::new(Mutex::new(RestartMode::Healthy)),
        }
    }
}

impl RoutableWorkerManager for FakeWorkerPool {
    async fn get_healthy_workers(&self) -> Vec<WorkerDescriptor> {
        let db = self.db.lock().await;
        let workers = db.workers().list().unwrap();
        workers
            .into_iter()
            .filter(|w| {
                w.enabled && (w.status == WorkerStatus::Ready || w.status == WorkerStatus::Busy)
            })
            .map(|w| {
                let active = db.sessions().count_by_worker(&w.id).unwrap();
                WorkerDescriptor {
                    record: w,
                    active_session_count: active,
                }
            })
            .collect()
    }

    async fn restart_worker(&self, id: &str) -> Result<(), RouteError> {
        self.restart_calls.lock().await.push(id.to_string());
        let mode = self.restart_mode.lock().await.clone();
        match mode {
            RestartMode::Healthy => {
                let db = self.db.lock().await;
                let _ = db.workers().set_state(
                    id,
                    manager_db::WorkerStatePatch::new(WorkerStatus::Ready).with_pid(Some(99)),
                );
                Ok(())
            }
            RestartMode::Fails => Err(RouteError::Worker("restart failed".to_string())),
        }
    }
}

async fn setup() -> (
    Arc<Mutex<ManagerDb>>,
    Arc<FakeWorkerPool>,
    SessionRouter<FakeWorkerPool>,
) {
    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let pool = Arc::new(FakeWorkerPool::new(db.clone()));
    let router = SessionRouter::new(db.clone(), pool.clone());
    (db, pool, router)
}

#[test]
fn test_cross_language_fallback_hash_parity() {
    assert_eq!(
        create_fallback_session_id("test-conn-123"),
        "fallback:f76c8ef64726ca82aa948d61"
    );
    assert_ne!(
        create_fallback_session_id("conn-a"),
        create_fallback_session_id("conn-b")
    );
}

#[tokio::test]
async fn test_keeps_existing_healthy_binding_sticky_and_persisted() {
    let (db, pool, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Ready))
            .unwrap();
    }

    let first = router
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "conn-1".to_string(),
        })
        .await
        .unwrap();

    let router2 = SessionRouter::new(db.clone(), pool.clone());
    let second = router2
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "conn-1".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(first.id, "worker-1");
    assert_eq!(second.id, "worker-1");

    let db_lock = db.lock().await;
    assert_eq!(
        db_lock.sessions().get("chat-a").unwrap().unwrap().worker_id,
        "worker-1"
    );
}

#[tokio::test]
async fn test_selects_by_least_sessions_then_failures_then_round_robin() {
    let (db, _, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 2, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .sessions()
            .upsert(&manager_db::SessionBinding {
                session_id: "existing".to_string(),
                worker_id: "worker-1".to_string(),
                created_at: NOW.to_string(),
                last_used_at: NOW.to_string(),
            })
            .unwrap();
    }

    // worker-1 has 1 session, worker-2 has 0 sessions -> picks worker-2
    let chosen = router
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "c-a".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(chosen.id, "worker-2");

    // Clear sessions
    {
        let db_lock = db.lock().await;
        db_lock.sessions().delete_for_worker("worker-1").unwrap();
        db_lock.sessions().delete_for_worker("worker-2").unwrap();
    }

    // Both have 0 sessions, worker-1 has 0 failures, worker-2 has 2 failures -> picks worker-1
    let chosen2 = router
        .resolve(&RouteContext {
            session_id: Some("chat-b".to_string()),
            connection_id: "c-b".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(chosen2.id, "worker-1");

    // Equalize failures to 0
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock.sessions().delete_for_worker("worker-1").unwrap();
        db_lock.sessions().delete_for_worker("worker-2").unwrap();
    }

    // Round-robin tie break between worker-1 and worker-2
    let tied1 = router
        .resolve(&RouteContext {
            session_id: Some("tie-1".to_string()),
            connection_id: "tie-c1".to_string(),
        })
        .await
        .unwrap();

    {
        let db_lock = db.lock().await;
        db_lock.sessions().delete_for_worker(&tied1.id).unwrap();
    }

    let tied2 = router
        .resolve(&RouteContext {
            session_id: Some("tie-2".to_string()),
            connection_id: "tie-c2".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(
        vec![tied1.id.as_str(), tied2.id.as_str()],
        vec!["worker-1", "worker-2"]
    );
}

#[tokio::test]
async fn test_fallback_session_id_and_missing_event() {
    let (db, _, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Ready))
            .unwrap();
    }

    router
        .resolve(&RouteContext {
            session_id: Some("   ".to_string()),
            connection_id: "conn-a".to_string(),
        })
        .await
        .unwrap();

    let db_lock = db.lock().await;
    let sessions = db_lock.sessions().list().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, create_fallback_session_id("conn-a"));

    let events = db_lock.events().list(None).unwrap();
    assert!(events.iter().any(|e| e.event_type == "SESSION_KEY_MISSING"));
}

#[tokio::test]
async fn test_no_healthy_worker_error() {
    let (db, _, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Offline))
            .unwrap();
    }

    let err = router
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "c".to_string(),
        })
        .await
        .unwrap_err();

    match err {
        RouteError::NoHealthyWorker => {}
        other => panic!("expected NoHealthyWorker, got: {other:?}"),
    }

    let db_lock = db.lock().await;
    assert_eq!(db_lock.sessions().list().unwrap().len(), 0);
}

#[tokio::test]
async fn test_keeps_binding_when_restart_recovers_bound_worker() {
    let (db, pool, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Degraded))
            .unwrap();
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .sessions()
            .upsert(&manager_db::SessionBinding {
                session_id: "chat-a".to_string(),
                worker_id: "worker-1".to_string(),
                created_at: NOW.to_string(),
                last_used_at: NOW.to_string(),
            })
            .unwrap();
    }

    let chosen = router
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "c".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(chosen.id, "worker-1");
    assert_eq!(pool.restart_calls.lock().await.as_slice(), &["worker-1"]);

    let db_lock = db.lock().await;
    assert_eq!(
        db_lock.sessions().get("chat-a").unwrap().unwrap().worker_id,
        "worker-1"
    );
}

#[tokio::test]
async fn test_rebinds_only_after_failed_recovery() {
    let (db, pool, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Degraded))
            .unwrap();
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .sessions()
            .upsert(&manager_db::SessionBinding {
                session_id: "chat-a".to_string(),
                worker_id: "worker-1".to_string(),
                created_at: NOW.to_string(),
                last_used_at: NOW.to_string(),
            })
            .unwrap();
    }

    *pool.restart_mode.lock().await = RestartMode::Fails;

    let chosen = router
        .resolve(&RouteContext {
            session_id: Some("chat-a".to_string()),
            connection_id: "c".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(chosen.id, "worker-2");

    let db_lock = db.lock().await;
    assert_eq!(
        db_lock.sessions().get("chat-a").unwrap().unwrap().worker_id,
        "worker-2"
    );
    let events = db_lock.events().list(None).unwrap();
    assert!(events.iter().any(|e| e.event_type == "SESSION_FAILOVER"));
}

#[tokio::test]
async fn test_concurrent_bind_converges_to_single_binding() {
    let (db, _, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 0, WorkerStatus::Ready))
            .unwrap();
    }

    let router = Arc::new(router);
    let mut handles = Vec::new();
    for i in 0..10 {
        let r = router.clone();
        handles.push(tokio::spawn(async move {
            r.resolve(&RouteContext {
                session_id: Some("concurrent-session".to_string()),
                connection_id: format!("conn-{i}"),
            })
            .await
            .unwrap()
        }));
    }

    let mut results = Vec::new();
    for h in handles {
        results.push(h.await.unwrap());
    }

    // All tasks must converge on the exact same worker ID
    let first_id = &results[0].id;
    for r in &results {
        assert_eq!(&r.id, first_id);
    }

    // Exactly one binding exists in database
    let db_lock = db.lock().await;
    let sessions = db_lock.sessions().list().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "concurrent-session");
    assert_eq!(&sessions[0].worker_id, first_id);
}

#[tokio::test]
async fn test_recovery_versus_worker_event_race() {
    let (db, pool, router) = setup().await;
    {
        let db_lock = db.lock().await;
        db_lock
            .workers()
            .upsert(&make_record("worker-1", 0, WorkerStatus::Degraded))
            .unwrap();
        db_lock
            .workers()
            .upsert(&make_record("worker-2", 0, WorkerStatus::Ready))
            .unwrap();
        db_lock
            .sessions()
            .upsert(&manager_db::SessionBinding {
                session_id: "chat-race".to_string(),
                worker_id: "worker-1".to_string(),
                created_at: NOW.to_string(),
                last_used_at: NOW.to_string(),
            })
            .unwrap();
    }

    // Simulate recovery failing due to an unexpected crash
    *pool.restart_mode.lock().await = RestartMode::Fails;

    let chosen = router
        .resolve(&RouteContext {
            session_id: Some("chat-race".to_string()),
            connection_id: "c-race".to_string(),
        })
        .await
        .unwrap();

    // Must never return worker-1; must fail over to healthy worker-2
    assert_eq!(chosen.id, "worker-2");
    assert_eq!(chosen.status, WorkerStatus::Ready);

    let db_lock = db.lock().await;
    assert_eq!(
        db_lock
            .sessions()
            .get("chat-race")
            .unwrap()
            .unwrap()
            .worker_id,
        "worker-2"
    );
}
