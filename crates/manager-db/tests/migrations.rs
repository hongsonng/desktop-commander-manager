use manager_db::ManagerDb;
use rusqlite::Connection;
use tempfile::NamedTempFile;

fn create_legacy_node_database(path: &std::path::Path) {
    let conn = Connection::open(path).expect("open legacy db");
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS workers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            pid INTEGER NULL,
            failure_count INTEGER NOT NULL DEFAULT 0,
            last_heartbeat_at TEXT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            worker_id TEXT NOT NULL REFERENCES workers(id),
            created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NULL,
            worker_id TEXT NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            metadata_json TEXT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_worker_id ON sessions(worker_id);
        CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);

        INSERT INTO workers (id, name, enabled, status, pid, failure_count, last_heartbeat_at, created_at, updated_at)
        VALUES ('worker-1', 'Worker 1', 1, 'READY', 1234, 0, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');

        INSERT INTO sessions (session_id, worker_id, created_at, last_used_at)
        VALUES ('sess-1', 'worker-1', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');

        INSERT INTO events (session_id, worker_id, type, message, metadata_json, created_at)
        VALUES ('sess-1', 'worker-1', 'WORKER_READY', 'ready', '{"info":"test"}', '2026-10-10T00:00:00Z');
        "#,
    ).expect("create legacy schema and data");
}

#[test]
fn test_legacy_node_schema_migration_preserves_data_and_adds_metadata() {
    let tmp = NamedTempFile::new().expect("temp file");
    create_legacy_node_database(tmp.path());

    // 1. Open with Rust ManagerDb
    let db = ManagerDb::open(tmp.path()).expect("open with manager-db");

    // 2. Verify legacy rows survived
    let worker_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM workers WHERE id = 'worker-1'",
            [],
            |r| r.get(0),
        )
        .expect("query workers");
    assert_eq!(worker_count, 1);

    let session_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_id = 'sess-1'",
            [],
            |r| r.get(0),
        )
        .expect("query sessions");
    assert_eq!(session_count, 1);

    let event_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM events WHERE type = 'WORKER_READY'",
            [],
            |r| r.get(0),
        )
        .expect("query events");
    assert_eq!(event_count, 1);

    // 3. Verify migration metadata was created
    let schema_ver: i32 = db
        .conn()
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .expect("query schema_version");
    assert_eq!(schema_ver, 1);

    let log_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM migration_log WHERE version = 1",
            [],
            |r| r.get(0),
        )
        .expect("query migration_log");
    assert_eq!(log_count, 1);

    // 4. Verify pragmas
    let fk: i32 = db
        .conn()
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .expect("query foreign_keys");
    assert_eq!(fk, 1);

    db.close().expect("close db");

    // 5. Reopen second time: does not fail or duplicate migrations
    let db2 = ManagerDb::open(tmp.path()).expect("reopen manager-db");
    let log_count2: i64 = db2
        .conn()
        .query_row("SELECT COUNT(*) FROM migration_log", [], |r| r.get(0))
        .expect("query migration_log again");
    assert_eq!(log_count2, 1);
    db2.close().expect("close db2");
}

#[test]
fn test_in_memory_migration_runs_cleanly() {
    let db = ManagerDb::open_in_memory().expect("open in memory");
    let schema_ver: i32 = db
        .conn()
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .expect("query schema_version");
    assert_eq!(schema_ver, 1);
    db.close().expect("close in-memory db");
}

#[test]
fn test_interrupted_migration_rolls_back_cleanly() {
    let tmp = NamedTempFile::new().expect("temp file");
    let mut conn = Connection::open(tmp.path()).expect("open db");

    // Initialize base migration
    manager_db::migrations::run_migrations(&mut conn).expect("run base migrations");

    // Attempt a transaction that executes a DDL followed by a forced syntax error
    let tx_res = (|| -> Result<(), rusqlite::Error> {
        let tx = conn.transaction()?;
        tx.execute("CREATE TABLE partial_mutation (id INTEGER);", [])?;
        // Intentionally invalid SQL to simulate failure during migration
        tx.execute("INVALID SQL STATEMENT ERROR", [])?;
        tx.commit()?;
        Ok(())
    })();

    assert!(tx_res.is_err());

    // Verify partial_mutation table was completely rolled back
    let table_exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='partial_mutation'",
            [],
            |r| r.get(0),
        )
        .expect("check table existence");
    assert_eq!(table_exists, 0);

    // Verify schema version is still 1
    let schema_ver: i32 = conn
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .expect("query schema_version");
    assert_eq!(schema_ver, 1);
}
