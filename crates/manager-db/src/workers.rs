use crate::models::{WorkerRecord, WorkerStatePatch};
use crate::DbError;
use chrono::Utc;
use rusqlite::Connection;

pub struct WorkerRepository<'a> {
    conn: &'a Connection,
}

impl<'a> WorkerRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn get(&self, id: &str) -> Result<Option<WorkerRecord>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, enabled, status, pid, failure_count, last_heartbeat_at, created_at, updated_at FROM workers WHERE id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(WorkerRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                status: row.get(3)?,
                pid: row.get(4)?,
                failure_count: row.get(5)?,
                last_heartbeat_at: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list(&self) -> Result<Vec<WorkerRecord>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, enabled, status, pid, failure_count, last_heartbeat_at, created_at, updated_at FROM workers ORDER BY id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(WorkerRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                status: row.get(3)?,
                pid: row.get(4)?,
                failure_count: row.get(5)?,
                last_heartbeat_at: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    pub fn upsert(&self, worker: &WorkerRecord) -> Result<(), DbError> {
        let mut stmt = self.conn.prepare(
            r#"INSERT INTO workers (id, name, enabled, status, pid, failure_count, last_heartbeat_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                enabled = excluded.enabled,
                status = excluded.status,
                pid = excluded.pid,
                failure_count = excluded.failure_count,
                last_heartbeat_at = excluded.last_heartbeat_at,
                updated_at = excluded.updated_at"#,
        )?;
        stmt.execute(rusqlite::params![
            worker.id,
            worker.name,
            if worker.enabled { 1 } else { 0 },
            worker.status.as_str(),
            worker.pid,
            worker.failure_count,
            worker.last_heartbeat_at,
            worker.created_at,
            worker.updated_at,
        ])?;
        Ok(())
    }

    pub fn set_state(&self, id: &str, patch: WorkerStatePatch) -> Result<(), DbError> {
        let current = match self.get(id)? {
            Some(w) => w,
            None => return Ok(()),
        };
        let updated = WorkerRecord {
            id: current.id,
            name: current.name,
            enabled: current.enabled,
            status: patch.status,
            pid: match patch.pid {
                Some(p) => p,
                None => current.pid,
            },
            failure_count: patch.failure_count.unwrap_or(current.failure_count),
            last_heartbeat_at: match patch.last_heartbeat_at {
                Some(hb) => hb,
                None => current.last_heartbeat_at,
            },
            created_at: current.created_at,
            updated_at: Utc::now().to_rfc3339(),
        };
        self.upsert(&updated)?;
        Ok(())
    }
}
