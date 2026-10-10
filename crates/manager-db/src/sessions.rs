use crate::models::SessionBinding;
use crate::DbError;
use rusqlite::Connection;

pub struct SessionRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SessionRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    pub fn get(&self, session_id: &str) -> Result<Option<SessionBinding>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, worker_id, created_at, last_used_at FROM sessions WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query(rusqlite::params![session_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(SessionBinding {
                session_id: row.get(0)?,
                worker_id: row.get(1)?,
                created_at: row.get(2)?,
                last_used_at: row.get(3)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list(&self) -> Result<Vec<SessionBinding>, DbError> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, worker_id, created_at, last_used_at FROM sessions ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionBinding {
                session_id: row.get(0)?,
                worker_id: row.get(1)?,
                created_at: row.get(2)?,
                last_used_at: row.get(3)?,
            })
        })?;
        let mut result = Vec::new();
        for r in rows {
            result.push(r?);
        }
        Ok(result)
    }

    pub fn upsert(&self, binding: &SessionBinding) -> Result<(), DbError> {
        let mut stmt = self.conn.prepare(
            r#"INSERT INTO sessions (session_id, worker_id, created_at, last_used_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(session_id) DO UPDATE SET
                worker_id = excluded.worker_id,
                last_used_at = excluded.last_used_at"#,
        )?;
        stmt.execute(rusqlite::params![
            binding.session_id,
            binding.worker_id,
            binding.created_at,
            binding.last_used_at,
        ])?;
        Ok(())
    }

    pub fn rebind(
        &self,
        session_id: &str,
        worker_id: &str,
        last_used_at: &str,
    ) -> Result<(), DbError> {
        let rows_affected = self.conn.execute(
            "UPDATE sessions SET worker_id = ?1, last_used_at = ?2 WHERE session_id = ?3",
            rusqlite::params![worker_id, last_used_at, session_id],
        )?;
        if rows_affected != 1 {
            return Err(DbError::SessionNotFound(session_id.to_string()));
        }
        Ok(())
    }

    pub fn delete_for_worker(&self, worker_id: &str) -> Result<usize, DbError> {
        let deleted = self.conn.execute(
            "DELETE FROM sessions WHERE worker_id = ?1",
            rusqlite::params![worker_id],
        )?;
        Ok(deleted)
    }

    pub fn count_by_worker(&self, worker_id: &str) -> Result<usize, DbError> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE worker_id = ?1",
            rusqlite::params![worker_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }
}
