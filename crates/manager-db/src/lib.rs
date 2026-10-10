pub mod events;
pub mod migrations;
pub mod models;
pub mod sessions;
pub mod workers;

pub use events::EventRepository;
pub use models::*;
pub use sessions::SessionRepository;
pub use workers::WorkerRepository;

use rusqlite::Connection;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] migrations::MigrationError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Session not found: {0}")]
    SessionNotFound(String),
}

pub struct ManagerDb {
    conn: Connection,
}

impl ManagerDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let p = path.as_ref();
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(p)?;
        migrations::run_migrations(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self, DbError> {
        let mut conn = Connection::open_in_memory()?;
        migrations::run_migrations(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn workers(&self) -> WorkerRepository<'_> {
        WorkerRepository::new(&self.conn)
    }

    pub fn sessions(&self) -> SessionRepository<'_> {
        SessionRepository::new(&self.conn)
    }

    pub fn events(&self) -> EventRepository<'_> {
        EventRepository::new(&self.conn)
    }

    pub fn reconcile_runtime_state(&self) -> Result<(), DbError> {
        let updated_at = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE workers SET status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'STOPPED' END, pid = NULL, updated_at = ?1",
            rusqlite::params![updated_at],
        )?;
        Ok(())
    }

    pub fn with_transaction<F, R>(&mut self, f: F) -> Result<R, DbError>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<R, DbError>,
    {
        let tx = self.conn.transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn record_worker_transition(
        &mut self,
        worker_id: &str,
        patch: WorkerStatePatch,
        event: &EventInput,
    ) -> Result<EventRecord, DbError> {
        self.with_transaction(|tx| {
            WorkerRepository::new(tx).set_state(worker_id, patch)?;
            EventRepository::new(tx).append(event)
        })
    }

    pub fn close(self) -> Result<(), DbError> {
        self.conn.close().map_err(|(_, err)| DbError::Sqlite(err))
    }
}
