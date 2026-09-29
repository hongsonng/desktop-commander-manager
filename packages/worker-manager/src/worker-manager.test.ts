import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '@dc-manager/database'
import type { ManagerDatabase } from '@dc-manager/database'
import type { WorkerRecord } from '@dc-manager/shared'
import { WorkerManager } from './worker-manager'
import { buildWorkerEnvironment, type DesktopCommanderProcessFactory, type WorkerProcessHandle } from './desktop-commander-process'

const roots: string[] = []
const now = '2026-09-29T00:00:00.000Z'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

class FakeFactory implements DesktopCommanderProcessFactory {
  nextPid = 100
  handles: Array<WorkerProcessHandle & { exitNow: () => void; stopCount: () => number }> = []
  async start(): Promise<WorkerProcessHandle> {
    const exit = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
    let stops = 0
    const handle = {
      pid: this.nextPid++, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exited: exit.promise,
      async stop() { stops++; exit.resolve({ code: 0, signal: null }) },
      exitNow: () => exit.resolve({ code: 1, signal: null }), stopCount: () => stops,
    }
    this.handles.push(handle)
    return handle
  }
}

function setup(): { db: ManagerDatabase; manager: WorkerManager; factory: FakeFactory; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dc-worker-manager-')); roots.push(root)
  const db = createDatabase(join(root, 'manager.db'))
  const worker: WorkerRecord = { id: 'worker-1', name: 'Worker 1', enabled: true, status: 'STOPPED', pid: null, failureCount: 0, lastHeartbeatAt: null, createdAt: now, updatedAt: now }
  db.workers.upsertWorker(worker)
  const factory = new FakeFactory()
  return { db, factory, root, manager: new WorkerManager({ database: db, processFactory: factory, runtimeRoot: join(root, 'workers') }) }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('WorkerManager', () => {
  it('starts at STARTING and becomes READY only after explicit handshake', async () => {
    const { db, manager } = setup()
    const handle = await manager.startWorker('worker-1')
    expect(db.workers.getWorker('worker-1')).toMatchObject({ status: 'STARTING', pid: handle.pid })
    manager.markReady('worker-1')
    expect(db.workers.getWorker('worker-1')?.status).toBe('READY')
    manager.markBusy('worker-1')
    expect(db.workers.getWorker('worker-1')?.status).toBe('BUSY')
    manager.markReady('worker-1')
    expect(manager.getHealthyWorkers().map((w) => w.id)).toEqual(['worker-1'])
    db.close()
  })

  it('marks an unexpected process exit degraded and increments failures', async () => {
    const { db, manager, factory } = setup()
    await manager.startWorker('worker-1'); manager.markReady('worker-1')
    factory.handles[0].exitNow(); await Promise.resolve(); await Promise.resolve()
    expect(db.workers.getWorker('worker-1')).toMatchObject({ status: 'DEGRADED', pid: null, failureCount: 1 })
    expect(db.events.listEvents().some((e) => e.type === 'WORKER_EXIT')).toBe(true)
    db.close()
  })

  it('restarts a worker and supports disable then enable', async () => {
    const { db, manager, factory } = setup()
    await manager.startWorker('worker-1'); manager.markReady('worker-1')
    await manager.restartWorker('worker-1')
    expect(factory.handles).toHaveLength(2)
    expect(factory.handles[0].stopCount()).toBe(1)
    expect(db.workers.getWorker('worker-1')).toMatchObject({ status: 'STARTING', pid: 101 })
    await manager.disableWorker('worker-1')
    expect(db.workers.getWorker('worker-1')).toMatchObject({ enabled: false, status: 'DISABLED', pid: null })
    manager.enableWorker('worker-1')
    expect(db.workers.getWorker('worker-1')).toMatchObject({ enabled: true, status: 'STOPPED' })
    db.close()
  })

  it('builds distinct absolute runtime environments per worker', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-worker-env-')); roots.push(root)
    const one = buildWorkerEnvironment(join(root, 'worker-1'), {})
    const two = buildWorkerEnvironment(join(root, 'worker-2'), {})
    for (const key of ['USERPROFILE', 'HOME', 'TEMP', 'TMP'] as const) {
      expect(one[key]).toBeTruthy(); expect(two[key]).toBeTruthy(); expect(one[key]).not.toBe(two[key]); expect(resolve(one[key]!)).toBe(one[key])
    }
  })
})
