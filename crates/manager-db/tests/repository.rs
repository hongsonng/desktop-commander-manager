use manager_db::{DbError, EventInput, ManagerDb, WorkerRecord, WorkerStatePatch, WorkerStatus};
use tempfile::NamedTempFile;

const NOW: &str = "2026-09-29T00:00:00.000Z";

fn make_worker(id: &str, status: WorkerStatus, enabled: bool, pid: Option<u32>) -> WorkerRecord {
    WorkerRecord {
        id: id.to_string(),
        name: format!("Worker {id}"),
        enabled,
        status,
        pid,
        failure_count: 0,
        last_heartbeat_at: Some(NOW.to_string()),
        created_at: NOW.to_string(),
        updated_at: NOW.to_string(),
    }
}

#[test]
fn test_persists_records_across_reopen() {
    let tmp = NamedTempFile::new().expect("temp file");
    {
        let db = ManagerDb::open(tmp.path()).expect("open db");
        db.workers()
            .upsert(&make_worker(
                "worker-1",
                WorkerStatus::Ready,
                true,
                Some(1234),
            ))
            .expect("upsert worker");

        db.sessions()
            .upsert(&manager_db::SessionBinding {
                session_id: "chat-a".to_string(),
                worker_id: "worker-1".to_string(),
                created_at: NOW.to_string(),
                last_used_at: NOW.to_string(),
            })
            .expect("upsert session");

        let event = db
            .events()
            .append(
                &EventInput::new("SESSION_BOUND", "bound")
                    .with_session("chat-a")
                    .with_worker("worker-1"),
            )
            .expect("append event");
        assert!(event.id > 0);
        db.close().expect("close db");
    }

    {
        let db = ManagerDb::open(tmp.path()).expect("reopen db");
        let worker = db
            .workers()
            .get("worker-1")
            .expect("get worker")
            .expect("worker exists");
        assert_eq!(worker.status, WorkerStatus::Ready);
        assert_eq!(worker.pid, Some(1234));

        let session = db
            .sessions()
            .get("chat-a")
            .expect("get session")
            .expect("session exists");
        assert_eq!(session.worker_id, "worker-1");

        let events = db.events().list(None).expect("list events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "SESSION_BOUND");
        assert_eq!(events[0].message, "bound");
        db.close().expect("close db");
    }
}

#[test]
fn test_reconciles_stale_runtime_state() {
    let db = ManagerDb::open_in_memory().expect("open db");
    db.workers()
        .upsert(&make_worker("ready", WorkerStatus::Ready, true, Some(10)))
        .expect("upsert ready");
    db.workers()
        .upsert(&make_worker(
            "offline",
            WorkerStatus::Offline,
            true,
            Some(11),
        ))
        .expect("upsert offline");
    db.workers()
        .upsert(&make_worker(
            "disabled",
            WorkerStatus::Disabled,
            false,
            Some(12),
        ))
        .expect("upsert disabled");

    db.reconcile_runtime_state().expect("reconcile");

    let ready = db.workers().get("ready").unwrap().unwrap();
    assert_eq!(ready.status, WorkerStatus::Stopped);
    assert_eq!(ready.pid, None);
    assert!(ready.enabled);

    let offline = db.workers().get("offline").unwrap().unwrap();
    assert_eq!(offline.status, WorkerStatus::Stopped);
    assert_eq!(offline.pid, None);
    assert!(offline.enabled);

    let disabled = db.workers().get("disabled").unwrap().unwrap();
    assert_eq!(disabled.status, WorkerStatus::Disabled);
    assert_eq!(disabled.pid, None);
    assert!(!disabled.enabled);
}

#[test]
fn test_rebinds_session_transactionally_and_cleanup() {
    let db = ManagerDb::open_in_memory().expect("open db");
    db.workers()
        .upsert(&make_worker("worker-1", WorkerStatus::Ready, true, Some(1)))
        .expect("upsert w1");
    db.workers()
        .upsert(&make_worker("worker-2", WorkerStatus::Ready, true, Some(2)))
        .expect("upsert w2");

    db.sessions()
        .upsert(&manager_db::SessionBinding {
            session_id: "chat-a".to_string(),
            worker_id: "worker-1".to_string(),
            created_at: NOW.to_string(),
            last_used_at: NOW.to_string(),
        })
        .expect("upsert session");

    db.sessions()
        .rebind("chat-a", "worker-2", "2026-09-29T00:01:00.000Z")
        .expect("rebind session");

    let session = db.sessions().get("chat-a").unwrap().unwrap();
    assert_eq!(session.worker_id, "worker-2");
    assert_eq!(session.last_used_at, "2026-09-29T00:01:00.000Z");

    assert_eq!(db.sessions().count_by_worker("worker-2").unwrap(), 1);
    assert_eq!(db.sessions().count_by_worker("worker-1").unwrap(), 0);

    let deleted = db.sessions().delete_for_worker("worker-2").unwrap();
    assert_eq!(deleted, 1);
    assert!(db.sessions().get("chat-a").unwrap().is_none());

    // Rebinding non-existent session errors with SessionNotFound
    let err = db
        .sessions()
        .rebind("chat-unknown", "worker-1", NOW)
        .unwrap_err();
    match err {
        DbError::SessionNotFound(id) => assert_eq!(id, "chat-unknown"),
        other => panic!("expected SessionNotFound, got: {other:?}"),
    }
}

#[test]
fn test_event_ordering_and_limit() {
    let db = ManagerDb::open_in_memory().expect("open db");
    for i in 1..=5 {
        db.events()
            .append(&EventInput::new("TEST_EVENT", format!("msg {i}")))
            .expect("append event");
    }

    let all = db.events().list(None).expect("list all");
    assert_eq!(all.len(), 5);
    // Descending order by id
    assert_eq!(all[0].message, "msg 5");
    assert_eq!(all[4].message, "msg 1");

    let limited = db.events().list(Some(2)).expect("list limited");
    assert_eq!(limited.len(), 2);
    assert_eq!(limited[0].message, "msg 5");
    assert_eq!(limited[1].message, "msg 4");
}

#[test]
fn test_atomic_transition_and_event() {
    let mut db = ManagerDb::open_in_memory().expect("open db");
    db.workers()
        .upsert(&make_worker("worker-1", WorkerStatus::Stopped, true, None))
        .expect("upsert worker");

    let patch = WorkerStatePatch::new(WorkerStatus::Ready).with_pid(Some(999));
    let event_input = EventInput::new("WORKER_READY", "Worker 1 ready").with_worker("worker-1");

    let event = db
        .record_worker_transition("worker-1", patch, &event_input)
        .expect("record transition");

    assert!(event.id > 0);
    assert_eq!(event.event_type, "WORKER_READY");

    let worker = db.workers().get("worker-1").unwrap().unwrap();
    assert_eq!(worker.status, WorkerStatus::Ready);
    assert_eq!(worker.pid, Some(999));

    // Verify rollback if transaction errors
    let res = db.with_transaction(|tx| -> Result<(), DbError> {
        manager_db::WorkerRepository::new(tx)
            .set_state("worker-1", WorkerStatePatch::new(WorkerStatus::Degraded))?;
        Err(DbError::SessionNotFound("force-fail".to_string()))
    });
    assert!(res.is_err());

    let worker_after_fail = db.workers().get("worker-1").unwrap().unwrap();
    assert_eq!(worker_after_fail.status, WorkerStatus::Ready);
}
