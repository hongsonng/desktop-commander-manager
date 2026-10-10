use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use manager_api::routes::create_router;
use manager_api::state::{ApiState, BoxFuture, WorkerActions};
use manager_db::{ManagerDb, WorkerRecord, WorkerStatePatch, WorkerStatus};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

#[derive(Default)]
struct MockActions {
    calls: Mutex<Vec<String>>,
    db: Option<Arc<Mutex<ManagerDb>>>,
}

impl WorkerActions for MockActions {
    fn restart<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.calls.lock().unwrap().push(format!("restart:{}", worker_id));
        if let Some(ref db) = self.db {
            let db = db.lock().unwrap();
            let _ = db.workers().set_state(
                worker_id,
                WorkerStatePatch::new(WorkerStatus::Ready).with_pid(Some(9999)),
            );
        }
        Box::pin(async { Ok(()) })
    }

    fn enable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.calls.lock().unwrap().push(format!("enable:{}", worker_id));
        if let Some(ref db) = self.db {
            let db = db.lock().unwrap();
            if let Ok(Some(mut w)) = db.workers().get(worker_id) {
                w.enabled = true;
                w.status = WorkerStatus::Ready;
                let _ = db.workers().upsert(&w);
            }
        }
        Box::pin(async { Ok(()) })
    }

    fn disable<'a>(&'a self, worker_id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.calls.lock().unwrap().push(format!("disable:{}", worker_id));
        if let Some(ref db) = self.db {
            let db = db.lock().unwrap();
            if let Ok(Some(mut w)) = db.workers().get(worker_id) {
                w.enabled = false;
                w.status = WorkerStatus::Disabled;
                w.pid = None;
                let _ = db.workers().upsert(&w);
            }
        }
        Box::pin(async { Ok(()) })
    }
}

async fn post_json(router: &axum::Router, uri: &str) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .method("POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let status = response.status();
    let body_bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&body_bytes).unwrap();
    (status, json)
}

#[tokio::test]
async fn test_worker_action_success_and_unknown_worker_404() {
    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let now = "2026-09-29T00:00:00.000Z".to_string();

    db.lock()
        .unwrap()
        .workers()
        .upsert(&WorkerRecord {
            id: "worker-1".to_string(),
            name: "worker-1".to_string(),
            enabled: true,
            status: WorkerStatus::Stopped,
            pid: None,
            failure_count: 0,
            last_heartbeat_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();

    let mock_actions = Arc::new(MockActions {
        calls: Mutex::new(Vec::new()),
        db: Some(db.clone()),
    });

    let mut state = ApiState::new(db.clone());
    state.actions = Some(mock_actions.clone());

    let router = create_router(state);

    // 1. Restart worker-1 -> 200
    let (status, res) = post_json(&router, "/api/workers/worker-1/restart").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(res["id"], "worker-1");
    assert_eq!(res["status"], "READY");
    assert_eq!(res["pid"], 9999);

    // 2. Disable worker-1 -> 200
    let (status, res) = post_json(&router, "/api/workers/worker-1/disable").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(res["id"], "worker-1");
    assert_eq!(res["enabled"], false);
    assert_eq!(res["status"], "DISABLED");

    // 3. Enable worker-1 -> 200
    let (status, res) = post_json(&router, "/api/workers/worker-1/enable").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(res["id"], "worker-1");
    assert_eq!(res["enabled"], true);
    assert_eq!(res["status"], "READY");

    assert_eq!(
        mock_actions.calls.lock().unwrap().clone(),
        vec![
            "restart:worker-1".to_string(),
            "disable:worker-1".to_string(),
            "enable:worker-1".to_string(),
        ]
    );

    // 4. Unknown worker actions -> 404 with exact contract shape
    for action in &["restart", "enable", "disable"] {
        let (status, err) = post_json(&router, &format!("/api/workers/unknown-worker/{}", action)).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(err["error"], "WORKER_NOT_FOUND");
        assert_eq!(err["workerId"], "unknown-worker");
    }

    // Ensure no calls were dispatched to the actions handler for unknown worker
    assert_eq!(
        mock_actions.calls.lock().unwrap().len(),
        3,
        "Unknown worker actions must not invoke supervisor/actions"
    );
}

#[tokio::test]
async fn test_concurrent_worker_actions_serialize_cleanly() {
    let db = Arc::new(Mutex::new(ManagerDb::open_in_memory().unwrap()));
    let now = "2026-09-29T00:00:00.000Z".to_string();

    db.lock()
        .unwrap()
        .workers()
        .upsert(&WorkerRecord {
            id: "worker-1".to_string(),
            name: "worker-1".to_string(),
            enabled: true,
            status: WorkerStatus::Ready,
            pid: Some(1000),
            failure_count: 0,
            last_heartbeat_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        })
        .unwrap();

    let mock_actions = Arc::new(MockActions {
        calls: Mutex::new(Vec::new()),
        db: Some(db.clone()),
    });

    let mut state = ApiState::new(db.clone());
    state.actions = Some(mock_actions.clone());

    let router = create_router(state);

    let mut handles = Vec::new();
    for i in 0..15 {
        let r = router.clone();
        let action = if i % 2 == 0 { "restart" } else { "enable" };
        handles.push(tokio::spawn(async move {
            post_json(&r, &format!("/api/workers/worker-1/{}", action)).await
        }));
    }

    for handle in handles {
        let (status, res) = handle.await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert_eq!(res["id"], "worker-1");
    }

    assert_eq!(mock_actions.calls.lock().unwrap().len(), 15);
}
