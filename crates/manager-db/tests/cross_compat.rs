use manager_db::{EventInput, ManagerDb, WorkerRecord, WorkerStatePatch, WorkerStatus};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::NamedTempFile;

#[test]
fn test_node_rust_node_database_cross_compatibility() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let tsx_cli = repo_root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let database_ts = repo_root
        .join("packages")
        .join("database")
        .join("src")
        .join("database.ts")
        .to_str()
        .unwrap()
        .replace('\\', "/");

    let tmp = NamedTempFile::new().expect("temp file");
    let db_path = tmp.path().to_str().expect("path string").replace('\\', "/");

    // 1. Node creates data using packages/database/src/database.ts
    let node_script_create = format!(
        r#"
        import {{ createDatabase }} from '{database_ts}';
        const db = createDatabase('{db_path}');
        db.workers.upsertWorker({{
            id: 'worker-1',
            name: 'Node Worker 1',
            enabled: true,
            status: 'READY',
            pid: 1234,
            failureCount: 0,
            lastHeartbeatAt: '2026-10-10T00:00:00Z',
            createdAt: '2026-10-10T00:00:00Z',
            updatedAt: '2026-10-10T00:00:00Z',
        }});
        db.sessions.upsertSession({{
            sessionId: 'sess-node',
            workerId: 'worker-1',
            createdAt: '2026-10-10T00:00:00Z',
            lastUsedAt: '2026-10-10T00:00:00Z',
        }});
        db.events.appendEvent({{
            sessionId: 'sess-node',
            workerId: 'worker-1',
            type: 'NODE_CREATED',
            message: 'created by node',
            metadataJson: null,
            createdAt: '2026-10-10T00:00:00Z',
        }});
        db.close();
        "#
    );

    let script1_file = tempfile::Builder::new()
        .suffix(".ts")
        .tempfile()
        .expect("temp ts file");
    fs::write(script1_file.path(), node_script_create).expect("write script1");

    let status = Command::new("node")
        .current_dir(repo_root)
        .args([
            tsx_cli.to_str().unwrap(),
            script1_file.path().to_str().unwrap(),
        ])
        .status()
        .expect("run node create script");
    assert!(status.success(), "node script create failed");

    // 2. Rust opens, reads, mutates, and closes
    {
        let db = ManagerDb::open(tmp.path()).expect("open with manager-db");

        // Verify Node data was read correctly
        let w1 = db
            .workers()
            .get("worker-1")
            .unwrap()
            .expect("worker-1 exists");
        assert_eq!(w1.name, "Node Worker 1");
        assert_eq!(w1.status, WorkerStatus::Ready);
        assert_eq!(w1.pid, Some(1234));

        let s1 = db
            .sessions()
            .get("sess-node")
            .unwrap()
            .expect("sess-node exists");
        assert_eq!(s1.worker_id, "worker-1");

        let events = db.events().list(None).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "NODE_CREATED");

        // Add a second worker from Rust
        db.workers()
            .upsert(&WorkerRecord {
                id: "worker-2".to_string(),
                name: "Rust Worker 2".to_string(),
                enabled: true,
                status: WorkerStatus::Ready,
                pid: Some(5678),
                failure_count: 0,
                last_heartbeat_at: Some("2026-10-10T00:01:00Z".to_string()),
                created_at: "2026-10-10T00:01:00Z".to_string(),
                updated_at: "2026-10-10T00:01:00Z".to_string(),
            })
            .expect("upsert worker-2");

        // Rebind session to worker-2
        db.sessions()
            .rebind("sess-node", "worker-2", "2026-10-10T00:02:00Z")
            .expect("rebind session");

        // Update worker-1 status to BUSY
        db.workers()
            .set_state("worker-1", WorkerStatePatch::new(WorkerStatus::Busy))
            .expect("set worker-1 state");

        // Append event from Rust
        db.events()
            .append(
                &EventInput::new("RUST_MUTATED", "modified by rust")
                    .with_session("sess-node")
                    .with_worker("worker-2"),
            )
            .expect("append rust event");

        db.close().expect("close db from rust");
    }

    // 3. Node reopens, verifies all mutations made by Rust, and reconciles state
    let node_script_verify = format!(
        r#"
        import {{ createDatabase }} from '{database_ts}';
        const db = createDatabase('{db_path}');
        
        const w1 = db.workers.getWorker('worker-1');
        if (!w1 || w1.status !== 'BUSY') {{
            console.error('Expected worker-1 to be BUSY, got:', w1);
            process.exit(1);
        }}

        const w2 = db.workers.getWorker('worker-2');
        if (!w2 || w2.name !== 'Rust Worker 2' || w2.status !== 'READY' || w2.pid !== 5678) {{
            console.error('Expected worker-2 with Rust attributes, got:', w2);
            process.exit(2);
        }}

        const sess = db.sessions.getSession('sess-node');
        if (!sess || sess.workerId !== 'worker-2' || sess.lastUsedAt !== '2026-10-10T00:02:00Z') {{
            console.error('Expected sess-node rebound to worker-2, got:', sess);
            process.exit(3);
        }}

        const events = db.events.listEvents();
        if (events.length !== 2 || events[0].type !== 'RUST_MUTATED' || events[1].type !== 'NODE_CREATED') {{
            console.error('Expected 2 events with RUST_MUTATED first, got:', events);
            process.exit(4);
        }}

        db.reconcileRuntimeState();
        const w1Reconciled = db.workers.getWorker('worker-1');
        const w2Reconciled = db.workers.getWorker('worker-2');
        if (w1Reconciled.status !== 'STOPPED' || w1Reconciled.pid !== null) {{
            console.error('Expected w1 reconciled to STOPPED, got:', w1Reconciled);
            process.exit(5);
        }}
        if (w2Reconciled.status !== 'STOPPED' || w2Reconciled.pid !== null) {{
            console.error('Expected w2 reconciled to STOPPED, got:', w2Reconciled);
            process.exit(6);
        }}

        db.close();
        "#
    );

    let script2_file = tempfile::Builder::new()
        .suffix(".ts")
        .tempfile()
        .expect("temp ts file");
    fs::write(script2_file.path(), node_script_verify).expect("write script2");

    let status2 = Command::new("node")
        .current_dir(repo_root)
        .args([
            tsx_cli.to_str().unwrap(),
            script2_file.path().to_str().unwrap(),
        ])
        .status()
        .expect("run node verify script");
    assert!(status2.success(), "node script verify failed");

    // 4. Rust opens again and verifies reconciled state
    {
        let db = ManagerDb::open(tmp.path()).expect("open after node reconcile");
        let w1 = db.workers().get("worker-1").unwrap().unwrap();
        assert_eq!(w1.status, WorkerStatus::Stopped);
        assert_eq!(w1.pid, None);
        let w2 = db.workers().get("worker-2").unwrap().unwrap();
        assert_eq!(w2.status, WorkerStatus::Stopped);
        assert_eq!(w2.pid, None);
        db.close().expect("close db final");
    }
}
