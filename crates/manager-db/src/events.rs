use crate::models::{EventInput, EventRecord};
use crate::DbError;
use rusqlite::Connection;

pub struct EventRepository<'a> {
    conn: &'a Connection,
}

impl<'a> EventRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn append(&self, event: &EventInput) -> Result<EventRecord, DbError> {
        self.conn.execute(
            "INSERT INTO events (session_id, worker_id, type, message, metadata_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                event.session_id,
                event.worker_id,
                event.event_type,
                event.message,
                event.metadata_json,
                event.created_at,
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(EventRecord {
            id,
            session_id: event.session_id.clone(),
            worker_id: event.worker_id.clone(),
            event_type: event.event_type.clone(),
            message: event.message.clone(),
            metadata_json: event.metadata_json.clone(),
            created_at: event.created_at.clone(),
        })
    }

    pub fn list(&self, limit: Option<usize>) -> Result<Vec<EventRecord>, DbError> {
        let limit_val = limit.unwrap_or(100) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, session_id, worker_id, type, message, metadata_json, created_at FROM events ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![limit_val], |row| {
            Ok(EventRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                worker_id: row.get(2)?,
                event_type: row.get(3)?,
                message: row.get(4)?,
                metadata_json: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }
}
