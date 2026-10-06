import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '@dc-manager/database'
import type { WorkerRecord } from '@dc-manager/shared'
import { createManagementApi } from './management-api'

const roots: string[] = []
const now = '2026-09-29T00:00:00.000Z'
function worker(id: string): WorkerRecord { return { id, name: id, enabled: true, status: 'READY', pid: 1, failureCount: 0, lastHeartbeatAt: now, createdAt: now, updatedAt: now } }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('management API', () => {
  it('serves manager state and worker actions on loopback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-api-')); roots.push(root); const db = createDatabase(join(root, 'db.sqlite'))
    db.workers.upsertWorker(worker('worker-1')); db.sessions.upsertSession({ sessionId: 'chat-a', workerId: 'worker-1', createdAt: now, lastUsedAt: now }); db.events.appendEvent({ sessionId: null, workerId: 'worker-1', type: 'READY', message: 'ready', metadataJson: null, createdAt: now }); db.events.appendEvent({ sessionId: 'chat-a', workerId: 'worker-1', type: 'TOOL_CALL', message: 'read_file OK', metadataJson: JSON.stringify({ toolName: 'read_file', status: 'OK', durationMs: 12, argsSummary: 'path=D:/repo/file.txt', failedOver: false }), createdAt: now })
    const calls: string[] = []
    const resources = {
      async snapshot() {
        return {
          available: true, sampledAt: now,
          total: { memoryBytes: 100, cpuPercent: 1.5 },
          system: { memoryUsedBytes: 200, totalMemoryBytes: 1000, cpuPercent: 12.5 },
          items: [{ id: 'manager', label: 'Manager', pid: 123, memoryBytes: 100, cpuPercent: 1.5, processCount: 1, status: 'running' as const }],
        }
      },
    }
    const api = await createManagementApi({ database: db, port: 0, resources, actions: { async restart(id) { calls.push(`restart:${id}`) }, async enable(id) { calls.push(`enable:${id}`) }, async disable(id) { calls.push(`disable:${id}`) } } })
    try {
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:/)
      expect((await (await fetch(`${api.url}/api/health`)).json() as { status: string }).status).toBe('ok')
      const workers = await (await fetch(`${api.url}/api/workers`)).json() as Array<{ id: string; activeSessionCount: number }>
      expect(workers).toEqual([expect.objectContaining({ id: 'worker-1', activeSessionCount: 1 })])
      expect(await (await fetch(`${api.url}/api/resources`)).json()).toEqual(expect.objectContaining({ available: true, total: { memoryBytes: 100, cpuPercent: 1.5 } }))
      expect(await (await fetch(`${api.url}/api/sessions`)).json()).toHaveLength(1)
      expect(await (await fetch(`${api.url}/api/events`)).json()).toHaveLength(1)
      expect(await (await fetch(`${api.url}/api/tool-calls`)).json()).toEqual([
        expect.objectContaining({ sessionId: 'chat-a', workerId: 'worker-1', toolName: 'read_file', status: 'OK', durationMs: 12, argsSummary: 'path=D:/repo/file.txt', failedOver: false }),
      ])
      for (const action of ['restart', 'enable', 'disable']) expect((await fetch(`${api.url}/api/workers/worker-1/${action}`, { method: 'POST' })).status).toBe(200)
      expect(calls).toEqual(['restart:worker-1', 'enable:worker-1', 'disable:worker-1'])
    } finally { await api.close(); db.close() }
  })

  it('reports the direct-local ChatGPT connection mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-connection-')); roots.push(root)
    const db = createDatabase(join(root, 'db.sqlite'))
    const api = await createManagementApi({
      database: db,
      port: 0,
      connectionInfo: {
        mode: 'direct-local',
        mcpUrl: 'http://127.0.0.1:8787/mcp',
        workerStrategy: 'sticky-failover',
      },
      actions: { async restart() {}, async enable() {}, async disable() {} },
    })
    try {
      expect(await (await fetch(`${api.url}/api/connection`)).json()).toEqual({
        mode: 'direct-local',
        mcpUrl: 'http://127.0.0.1:8787/mcp',
        workerStrategy: 'sticky-failover',
      })
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

  it('returns 404 for an unknown worker without invoking actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-api-')); roots.push(root); const db = createDatabase(join(root, 'db.sqlite')); const calls: string[] = []
    const api = await createManagementApi({
      database: db,
      port: 0,
      actions: { async restart(id) { calls.push(id) }, async enable(id) { calls.push(id) }, async disable(id) { calls.push(id) } },
    })
    try {
      expect((await fetch(`${api.url}/api/workers/missing/restart`, { method: 'POST' })).status).toBe(404)
      expect(calls).toEqual([])
    } finally { await api.close(); db.close() }
  })
})
