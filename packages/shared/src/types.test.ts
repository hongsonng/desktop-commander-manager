import { describe, expect, it } from 'vitest'
import { REMOTE_ACCOUNT_STATUSES, WORKER_STATUSES } from './types'
import type { EventRecord, RemoteAccountRecord, SessionBinding, WorkerRecord } from './types'

describe('shared domain contracts', () => {
  it('defines the allowed worker states', () => {
    expect(WORKER_STATUSES).toEqual([
      'STOPPED', 'STARTING', 'READY', 'BUSY', 'DEGRADED', 'OFFLINE', 'DISABLED',
    ])
  })

  it('defines the allowed remote account states', () => {
    expect(REMOTE_ACCOUNT_STATUSES).toEqual([
      'STOPPED', 'STARTING', 'RUNNING', 'PAIRING', 'ERROR', 'DISABLED',
    ])
  })

  it('supports serializable worker, session, event, and remote account records', () => {
    const worker = { id: 'worker-1', name: 'Worker 1', enabled: true, status: 'READY', pid: 123, failureCount: 0, lastHeartbeatAt: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' } satisfies WorkerRecord
    const session = { sessionId: 'chat-a', workerId: 'worker-1', createdAt: '2026-09-29T00:00:00.000Z', lastUsedAt: '2026-09-29T00:00:00.000Z' } satisfies SessionBinding
    const event = { id: 1, sessionId: 'chat-a', workerId: 'worker-1', type: 'SESSION_BOUND', message: 'bound', metadataJson: null, createdAt: '2026-09-29T00:00:00.000Z' } satisfies EventRecord
    const account = { id: 'account-a', name: 'Account A', enabled: true, status: 'STOPPED', pid: null, profileDir: 'D:/profiles/account-a', lastStartedAt: null, lastUsedAt: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' } satisfies RemoteAccountRecord
    expect(JSON.parse(JSON.stringify({ worker, session, event, account }))).toEqual({ worker, session, event, account })
  })
})
