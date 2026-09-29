import { DatabaseSync } from 'node:sqlite'
import type { EventRecord, SessionBinding, WorkerRecord, WorkerStatus } from '@dc-manager/shared'
import { SCHEMA_SQL } from './schema.js'

type EventInput = Omit<EventRecord, 'id'>
type WorkerStatePatch = {
  status: WorkerStatus
  pid?: number | null
  failureCount?: number
  lastHeartbeatAt?: string | null
}

function mapWorker(row: Record<string, unknown>): WorkerRecord {
  return {
    id: String(row.id), name: String(row.name), enabled: Boolean(row.enabled),
    status: row.status as WorkerStatus, pid: row.pid == null ? null : Number(row.pid),
    failureCount: Number(row.failure_count), lastHeartbeatAt: row.last_heartbeat_at == null ? null : String(row.last_heartbeat_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  }
}

function mapSession(row: Record<string, unknown>): SessionBinding {
  return { sessionId: String(row.session_id), workerId: String(row.worker_id), createdAt: String(row.created_at), lastUsedAt: String(row.last_used_at) }
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: Number(row.id), sessionId: row.session_id == null ? null : String(row.session_id), workerId: row.worker_id == null ? null : String(row.worker_id),
    type: String(row.type), message: String(row.message), metadataJson: row.metadata_json == null ? null : String(row.metadata_json), createdAt: String(row.created_at),
  }
}

export interface ManagerDatabase {
  workers: {
    getWorker(id: string): WorkerRecord | undefined
    listWorkers(): WorkerRecord[]
    upsertWorker(worker: WorkerRecord): void
    setWorkerState(id: string, patch: WorkerStatePatch): void
  }
  sessions: {
    getSession(sessionId: string): SessionBinding | undefined
    listSessions(): SessionBinding[]
    upsertSession(binding: SessionBinding): void
    rebindSession(sessionId: string, workerId: string, lastUsedAt: string): void
    deleteSessionsForWorker(workerId: string): void
    countByWorker(workerId: string): number
  }
  events: {
    appendEvent(event: EventInput): EventRecord
    listEvents(limit?: number): EventRecord[]
  }
  reconcileRuntimeState(): void
  close(): void
}

export function createDatabase(path: string): ManagerDatabase {
  const db = new DatabaseSync(path)
  db.exec(SCHEMA_SQL)

  const getWorkerStmt = db.prepare('SELECT * FROM workers WHERE id = ?')
  const listWorkersStmt = db.prepare('SELECT * FROM workers ORDER BY id')
  const upsertWorkerStmt = db.prepare(`INSERT INTO workers (id,name,enabled,status,pid,failure_count,last_heartbeat_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, enabled=excluded.enabled, status=excluded.status, pid=excluded.pid,
    failure_count=excluded.failure_count, last_heartbeat_at=excluded.last_heartbeat_at, updated_at=excluded.updated_at`)

  const api: ManagerDatabase = {
    workers: {
      getWorker(id) {
        const row = getWorkerStmt.get(id) as Record<string, unknown> | undefined
        return row ? mapWorker(row) : undefined
      },
      listWorkers() { return (listWorkersStmt.all() as Record<string, unknown>[]).map(mapWorker) },
      upsertWorker(worker) {
        upsertWorkerStmt.run(worker.id, worker.name, worker.enabled ? 1 : 0, worker.status, worker.pid, worker.failureCount, worker.lastHeartbeatAt, worker.createdAt, worker.updatedAt)
      },
      setWorkerState(id, patch) {
        const current = api.workers.getWorker(id)
        if (!current) return
        api.workers.upsertWorker({ ...current, status: patch.status, pid: patch.pid === undefined ? current.pid : patch.pid, failureCount: patch.failureCount ?? current.failureCount, lastHeartbeatAt: patch.lastHeartbeatAt === undefined ? current.lastHeartbeatAt : patch.lastHeartbeatAt, updatedAt: new Date().toISOString() })
      },
    },
    sessions: {
      getSession(sessionId) {
        const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined
        return row ? mapSession(row) : undefined
      },
      listSessions() { return (db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as Record<string, unknown>[]).map(mapSession) },
      upsertSession(binding) {
        db.prepare(`INSERT INTO sessions (session_id,worker_id,created_at,last_used_at) VALUES (?,?,?,?)
          ON CONFLICT(session_id) DO UPDATE SET worker_id=excluded.worker_id,last_used_at=excluded.last_used_at`).run(binding.sessionId, binding.workerId, binding.createdAt, binding.lastUsedAt)
      },
      rebindSession(sessionId, workerId, lastUsedAt) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const result = db.prepare('UPDATE sessions SET worker_id = ?, last_used_at = ? WHERE session_id = ?').run(workerId, lastUsedAt, sessionId)
          if (Number(result.changes) !== 1) throw new Error(`Session not found: ${sessionId}`)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      },
      deleteSessionsForWorker(workerId) { db.prepare('DELETE FROM sessions WHERE worker_id = ?').run(workerId) },
      countByWorker(workerId) { return Number((db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE worker_id = ?').get(workerId) as { count: number | bigint }).count) },
    },
    events: {
      appendEvent(event) {
        const result = db.prepare('INSERT INTO events (session_id,worker_id,type,message,metadata_json,created_at) VALUES (?,?,?,?,?,?)').run(event.sessionId, event.workerId, event.type, event.message, event.metadataJson, event.createdAt)
        return { id: Number(result.lastInsertRowid), ...event }
      },
      listEvents(limit = 100) { return (db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(mapEvent) },
    },
    reconcileRuntimeState() {
      db.prepare(`UPDATE workers SET status = CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'STOPPED' END, pid = NULL, updated_at = ?`).run(new Date().toISOString())
    },
    close() { db.close() },
  }

  return api
}
