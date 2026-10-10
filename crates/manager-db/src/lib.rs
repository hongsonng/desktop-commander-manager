pub mod migrations;
pub mod models;

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

    pub fn close(self) -> Result<(), DbError> {
        self.conn.close().map_err(|(_, err)| DbError::Sqlite(err))
    }
}
