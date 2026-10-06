import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDatabase } from './database'
import type { WorkerRecord } from '@dc-manager/shared'

const roots: string[] = []
const now = '2026-09-29T00:00:00.000Z'

function tempDb() {
  const root = mkdtempSync(join(tmpdir(), 'dc-manager-db-'))
  roots.push(root)
  return join(root, 'manager.db')
}

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return { id: 'worker-1', name: 'Worker 1', enabled: true, status: 'READY', pid: 1234, failureCount: 0, lastHeartbeatAt: now, createdAt: now, updatedAt: now, ...overrides }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('manager database', () => {
  it('persists worker, session, and event records across reopen', () => {
    const path = tempDb()
    let db = createDatabase(path)
    db.workers.upsertWorker(worker())
    db.sessions.upsertSession({ sessionId: 'chat-a', workerId: 'worker-1', createdAt: now, lastUsedAt: now })
    const event = db.events.appendEvent({ sessionId: 'chat-a', workerId: 'worker-1', type: 'SESSION_BOUND', message: 'bound', metadataJson: null, createdAt: now })
    expect(event.id).toBeGreaterThan(0)
    db.close()

    db = createDatabase(path)
    expect(db.workers.getWorker('worker-1')).toMatchObject({ status: 'READY', pid: 1234 })
    expect(db.sessions.getSession('chat-a')).toMatchObject({ workerId: 'worker-1' })
    expect(db.events.listEvents()).toHaveLength(1)
    db.close()
  })

  it('reconciles stale runtime state without changing disabled intent', () => {
    const path = tempDb()
    const db = createDatabase(path)
    db.workers.upsertWorker(worker({ id: 'ready', status: 'READY', pid: 10 }))
    db.workers.upsertWorker(worker({ id: 'offline', status: 'OFFLINE', pid: 11 }))
    db.workers.upsertWorker(worker({ id: 'disabled', enabled: false, status: 'DISABLED', pid: 12 }))
    db.reconcileRuntimeState()
    expect(db.workers.getWorker('ready')).toMatchObject({ status: 'STOPPED', pid: null, enabled: true })
    expect(db.workers.getWorker('offline')).toMatchObject({ status: 'STOPPED', pid: null, enabled: true })
    expect(db.workers.getWorker('disabled')).toMatchObject({ status: 'DISABLED', pid: null, enabled: false })
    db.close()
  })

  it('rebinds a session transactionally and supports worker session cleanup', () => {
    const path = tempDb()
    const db = createDatabase(path)
    db.workers.upsertWorker(worker({ id: 'worker-1' }))
    db.workers.upsertWorker(worker({ id: 'worker-2' }))
    db.sessions.upsertSession({ sessionId: 'chat-a', workerId: 'worker-1', createdAt: now, lastUsedAt: now })
    db.sessions.rebindSession('chat-a', 'worker-2', '2026-09-29T00:01:00.000Z')
    expect(db.sessions.getSession('chat-a')).toMatchObject({ workerId: 'worker-2', lastUsedAt: '2026-09-29T00:01:00.000Z' })
    expect(db.sessions.countByWorker('worker-2')).toBe(1)
    db.sessions.deleteSessionsForWorker('worker-2')
    expect(db.sessions.getSession('chat-a')).toBeUndefined()
    db.close()
  })
})
