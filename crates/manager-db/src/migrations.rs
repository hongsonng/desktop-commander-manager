use chrono::Utc;
use rusqlite::{Connection, Transaction};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("SQLite error during migration: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Migration {version} failed: {reason}")]
    Failed { version: i32, reason: String },
}

pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub up: fn(&Transaction) -> Result<(), MigrationError>,
}

fn migration_1_base_schema(tx: &Transaction) -> Result<(), MigrationError> {
    tx.execute_batch(
        r#"
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
        "#,
    )?;
    Ok(())
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "0001_base_schema",
    up: migration_1_base_schema,
}];

pub fn run_migrations(conn: &mut Connection) -> Result<(), MigrationError> {
    // 1. Enable pragmas
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        "#,
    )?;

    // 2. Ensure migration tables exist
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS migration_log (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
        "#,
    )?;

    // 3. Determine current applied version
    let current_version: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM migration_log",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // 4. Apply pending migrations transactionally
    for migration in MIGRATIONS {
        if migration.version > current_version {
            let tx = conn.transaction()?;

            // Execute migration step
            (migration.up)(&tx)?;

            // Log migration
            let now = Utc::now().to_rfc3339();
            tx.execute(
                "INSERT INTO migration_log (version, name, applied_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![migration.version, migration.name, now],
            )?;

            // Update schema_version
            tx.execute("DELETE FROM schema_version", [])?;
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                rusqlite::params![migration.version],
            )?;

            tx.commit()?;
        }
    }

    Ok(())
}
