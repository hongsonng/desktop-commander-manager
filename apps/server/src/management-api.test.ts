import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '@dc-manager/database'
import type { RemoteAccountRecord, WorkerRecord } from '@dc-manager/shared'
import { createManagementApi } from './management-api'

const roots: string[] = []
const now = '2026-09-29T00:00:00.000Z'
function worker(id: string): WorkerRecord { return { id, name: id, enabled: true, status: 'READY', pid: 1, failureCount: 0, lastHeartbeatAt: now, createdAt: now, updatedAt: now } }
function account(id = 'account-a'): RemoteAccountRecord { return { id, name: id, enabled: true, status: 'STOPPED', pid: null, profileDir: `D:/profiles/${id}`, lastStartedAt: null, lastUsedAt: null, createdAt: now, updatedAt: now } }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('management API', () => {
  it('serves manager state, worker actions, and remote account rotation actions on loopback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-api-')); roots.push(root); const db = createDatabase(join(root, 'db.sqlite'))
    db.workers.upsertWorker(worker('worker-1')); db.sessions.upsertSession({ sessionId: 'chat-a', workerId: 'worker-1', createdAt: now, lastUsedAt: now }); db.events.appendEvent({ sessionId: null, workerId: 'worker-1', type: 'READY', message: 'ready', metadataJson: null, createdAt: now })
    const calls: string[] = []
    const remoteCalls: string[] = []
    const remoteAccounts = {
      list: () => [{ ...account(), paired: false }],
      add: (name: string, id: string) => { remoteCalls.push(`add:${id}:${name}`); return account(id) },
      activate: async (id: string) => { remoteCalls.push(`activate:${id}`); return account(id) },
      stop: async (id: string) => { remoteCalls.push(`stop:${id}`); return account(id) },
      enable: async (id: string) => { remoteCalls.push(`enable:${id}`); return account(id) },
      disable: async (id: string) => { remoteCalls.push(`disable:${id}`); return account(id) },
      rotate: async () => { remoteCalls.push('rotate'); return account('account-b') },
    }
    db.remoteAccounts.upsertAccount(account())
    const api = await createManagementApi({ database: db, port: 0, remoteAccounts, actions: { async restart(id) { calls.push(`restart:${id}`) }, async enable(id) { calls.push(`enable:${id}`) }, async disable(id) { calls.push(`disable:${id}`) } } })
    try {
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect((await (await fetch(`${api.url}/api/health`)).json() as { status: string }).status).toBe('ok')
      const workers = await (await fetch(`${api.url}/api/workers`)).json() as Array<{ id: string; activeSessionCount: number }>
      expect(workers).toEqual([expect.objectContaining({ id: 'worker-1', activeSessionCount: 1 })])
      expect(await (await fetch(`${api.url}/api/sessions`)).json()).toHaveLength(1)
      expect(await (await fetch(`${api.url}/api/events`)).json()).toHaveLength(1)
      for (const action of ['restart', 'enable', 'disable']) expect((await fetch(`${api.url}/api/workers/worker-1/${action}`, { method: 'POST' })).status).toBe(200)
      expect(calls).toEqual(['restart:worker-1', 'enable:worker-1', 'disable:worker-1'])

      expect(await (await fetch(`${api.url}/api/remote-accounts`)).json()).toEqual([expect.objectContaining({ id: 'account-a', paired: false })])
      expect((await fetch(`${api.url}/api/remote-accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'account-b', name: 'Account B' }) })).status).toBe(201)
      for (const action of ['activate', 'stop', 'enable', 'disable']) expect((await fetch(`${api.url}/api/remote-accounts/account-a/${action}`, { method: 'POST' })).status).toBe(200)
      expect((await fetch(`${api.url}/api/remote-accounts/rotate`, { method: 'POST' })).status).toBe(200)
      expect(remoteCalls).toEqual(['add:account-b:Account B', 'activate:account-a', 'stop:account-a', 'enable:account-a', 'disable:account-a', 'rotate'])
    } finally { await api.close(); db.close() }
  })

  it('serves the production dashboard from the same management origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-dashboard-static-')); roots.push(root)
    const dashboardDir = join(root, 'dist')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dashboardDir, { recursive: true })
    writeFileSync(join(dashboardDir, 'index.html'), '<!doctype html><title>DCM_TEST_MARKER</title>')
    const db = createDatabase(join(root, 'db.sqlite'))
    const api = await createManagementApi({ database: db, port: 0, dashboardDir, actions: { async restart() {}, async enable() {}, async disable() {} } })
    try {
      const response = await fetch(`${api.url}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('DCM_TEST_MARKER')
    } finally { await api.close(); db.close() }
  })

  it('returns 404 for unknown worker and remote account without invoking actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-api-')); roots.push(root); const db = createDatabase(join(root, 'db.sqlite')); const calls: string[] = []; const remoteCalls: string[] = []
    const api = await createManagementApi({
      database: db,
      port: 0,
      actions: { async restart(id) { calls.push(id) }, async enable(id) { calls.push(id) }, async disable(id) { calls.push(id) } },
      remoteAccounts: {
        list: () => [], add: () => account(),
        async activate(id) { remoteCalls.push(id); return account(id) }, async stop(id) { remoteCalls.push(id); return account(id) },
        async enable(id) { remoteCalls.push(id); return account(id) }, async disable(id) { remoteCalls.push(id); return account(id) }, async rotate() { return account() },
      },
    })
    try {
      expect((await fetch(`${api.url}/api/workers/missing/restart`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${api.url}/api/remote-accounts/missing/activate`, { method: 'POST' })).status).toBe(404)
      expect(calls).toEqual([]); expect(remoteCalls).toEqual([])
    } finally { await api.close(); db.close() }
  })
})
