import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '@dc-manager/database'
import type { DesktopCommanderProcessFactory, WorkerProcessHandle } from '@dc-manager/worker-manager'
import type { ProxyWorkerClient } from '@dc-manager/mcp-proxy'
import { startManager } from './main'

const roots: string[] = []
class FakeProcesses implements DesktopCommanderProcessFactory {
  nextPid = 500; stopped: number[] = []
  async start(): Promise<WorkerProcessHandle> {
    const pid = this.nextPid++; let resolveExit!: () => void; const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveExit = () => resolve({ code: 0, signal: null }) })
    return { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exited, stop: async () => { this.stopped.push(pid); resolveExit() } }
  }
}
class FakeWorkerClients {
  failWorkerId?: string; closed: string[] = []
  async connect(_handle: WorkerProcessHandle, workerId: string): Promise<ProxyWorkerClient> {
    if (workerId === this.failWorkerId) throw new Error('handshake failed')
    return { async listTools() { return { tools: [] } as never }, async callTool() { return { content: [] } as never }, close: async () => { this.closed.push(workerId) } }
  }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('startManager', () => {
  it('reconciles stale runtime state, seeds two workers once, handshakes, and shuts down', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-main-')); roots.push(root); const dbPath = join(root, 'manager.db')
    let db = createDatabase(dbPath)
    db.workers.upsertWorker({ id: 'worker-1', name: 'worker-1', enabled: true, status: 'READY', pid: 999, failureCount: 0, lastHeartbeatAt: null, createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:00.000Z' }); db.close()
    const processes = new FakeProcesses(); const clients = new FakeWorkerClients()
    const runtime = await startManager({ databasePath: dbPath, runtimeRoot: join(root, 'workers'), mcpPort: 0, managementPort: 0 }, { processFactory: processes, workerClientFactory: clients })
    expect(await runtime.state.listWorkers()).toHaveLength(1)
    expect(await runtime.state.getWorker('worker-1')).toMatchObject({ status: 'READY', pid: 500 })
    await runtime.close(); expect(processes.stopped).toEqual([500])

    const runtime2 = await startManager({ databasePath: dbPath, runtimeRoot: join(root, 'workers'), mcpPort: 0, managementPort: 0 }, { processFactory: new FakeProcesses(), workerClientFactory: new FakeWorkerClients() })
    expect(await runtime2.state.listWorkers()).toHaveLength(1); await runtime2.close()
  })

  it('seeds two default workers for a fresh database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-main-')); roots.push(root)
    const runtime = await startManager({ databasePath: join(root, 'manager.db'), runtimeRoot: join(root, 'workers'), mcpPort: 0, managementPort: 0 }, { processFactory: new FakeProcesses(), workerClientFactory: new FakeWorkerClients() })
    expect((await runtime.state.listWorkers()).map((w) => w.id)).toEqual(['worker-1', 'worker-2']); await runtime.close()
  })

  it('marks a worker degraded and stops its process when MCP handshake fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-main-')); roots.push(root)
    const clients = new FakeWorkerClients(); clients.failWorkerId = 'worker-2'
    const processes = new FakeProcesses()
    const runtime = await startManager({ databasePath: join(root, 'manager.db'), runtimeRoot: join(root, 'workers'), mcpPort: 0, managementPort: 0 }, { processFactory: processes, workerClientFactory: clients })
    expect((await runtime.state.getWorker('worker-1'))?.status).toBe('READY')
    expect((await runtime.state.getWorker('worker-2'))?.status).toBe('DEGRADED')
    expect(processes.stopped).toContain(501)
    await runtime.close()
  })

  it('initializes with platformOwner="rust" and sidecar override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-main-')); roots.push(root)
    const fakeSidecar = {
      snapshot: async () => ({
        manager: { rootPid: 123, memoryBytes: 1000, cpuSeconds: 1, processCount: 1 },
        tunnel: { rootPid: null, memoryBytes: 0, cpuSeconds: 0, processCount: 0 },
        workers: [],
      }),
      close: async () => undefined,
    } as any

    const runtime = await startManager(
      {
        databasePath: join(root, 'manager.db'),
        runtimeRoot: join(root, 'workers'),
        mcpPort: 0,
        managementPort: 0,
        platformOwner: 'rust',
      },
      {
        processFactory: new FakeProcesses(),
        workerClientFactory: new FakeWorkerClients(),
        sidecarClient: fakeSidecar,
      },
    )
    expect(runtime.managementUrl).toBeTruthy()
    await runtime.close()
  })
})
