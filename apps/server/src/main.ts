import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createDatabase, type ManagerDatabase } from '@dc-manager/database'
import { WorkerClient, type ProxyWorkerClient } from '@dc-manager/mcp-proxy'
import { RetryPolicy, SessionRouter, UpstreamCallError } from '@dc-manager/router'
import type { WorkerRecord } from '@dc-manager/shared'
import { WorkerManager, createDesktopCommanderProcessFactory, type DesktopCommanderProcessFactory, type WorkerProcessHandle } from '@dc-manager/worker-manager'
import { createMcpHttpServer } from './mcp-server.js'
import { createManagementApi } from './management-api.js'
import { DEFAULT_MANAGEMENT_PORT, DEFAULT_MCP_PORT, type ManagerConfig } from './config.js'

interface WorkerClientFactory {
  connect(handle: WorkerProcessHandle, workerId: string): Promise<ProxyWorkerClient>
}

type Overrides = {
  processFactory?: DesktopCommanderProcessFactory
  workerClientFactory?: WorkerClientFactory
}

export interface ManagerRuntime {
  database: ManagerDatabase
  mcpUrl: string
  managementUrl: string
  close(): Promise<void>
}

function defaultWorker(id: string, now: string): WorkerRecord {
  return { id, name: id === 'worker-1' ? 'Worker 1' : 'Worker 2', enabled: true, status: 'STOPPED', pid: null, failureCount: 0, lastHeartbeatAt: null, createdAt: now, updatedAt: now }
}

export async function startManager(config: ManagerConfig, overrides: Overrides = {}): Promise<ManagerRuntime> {
  mkdirSync(dirname(config.databasePath), { recursive: true })
  mkdirSync(config.runtimeRoot, { recursive: true })
  const database = createDatabase(config.databasePath)
  database.reconcileRuntimeState()
  if (database.workers.listWorkers().length === 0) {
    const now = new Date().toISOString()
    database.workers.upsertWorker(defaultWorker('worker-1', now))
    database.workers.upsertWorker(defaultWorker('worker-2', now))
  }

  const processFactory = overrides.processFactory ?? createDesktopCommanderProcessFactory()
  const workerClientFactory: WorkerClientFactory = overrides.workerClientFactory ?? { connect: (handle) => WorkerClient.connect(handle) }
  const workerManager = new WorkerManager({ database, processFactory, runtimeRoot: config.runtimeRoot })
  const clients = new Map<string, ProxyWorkerClient>()

  const connectWorker = async (workerId: string, handle: WorkerProcessHandle): Promise<void> => {
    try {
      const client = await workerClientFactory.connect(handle, workerId)
      clients.set(workerId, client)
      workerManager.markReady(workerId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await workerManager.degradeWorker(workerId, message)
      database.events.appendEvent({ sessionId: null, workerId, type: 'WORKER_HANDSHAKE_FAILED', message, metadataJson: null, createdAt: new Date().toISOString() })
    }
  }

  for (const worker of database.workers.listWorkers().filter((item) => item.enabled)) {
    try { await connectWorker(worker.id, await workerManager.startWorker(worker.id)) } catch { /* WorkerManager persisted OFFLINE */ }
  }

  const recoverWorker = async (workerId: string): Promise<void> => {
    await clients.get(workerId)?.close().catch(() => undefined)
    clients.delete(workerId)
    await connectWorker(workerId, await workerManager.restartWorker(workerId))
  }
  const routableWorkers = {
    getHealthyWorkers: () => workerManager.getHealthyWorkers(),
    restartWorker: recoverWorker,
  }
  const sessionRouter = new SessionRouter({ database, workerManager: routableWorkers })
  const retryPolicy = new RetryPolicy()
  const mcpRuntime = await createMcpHttpServer({
    host: '127.0.0.1', port: config.mcpPort ?? DEFAULT_MCP_PORT, sessionRouter, retryPolicy,
    getWorkerClient(workerId) {
      const client = clients.get(workerId)
      if (!client) throw new UpstreamCallError('PRE_DISPATCH', `Worker client is not connected: ${workerId}`)
      return client
    },
  })

  const actions = {
    async restart(id: string) {
      await recoverWorker(id)
    },
    async enable(id: string) {
      workerManager.enableWorker(id)
      await connectWorker(id, await workerManager.startWorker(id))
    },
    async disable(id: string) {
      await clients.get(id)?.close().catch(() => undefined); clients.delete(id)
      await workerManager.disableWorker(id)
    },
  }
  const defaultDashboardDir = resolve(process.cwd(), 'apps', 'dashboard', 'dist')
  const dashboardDir = config.dashboardDir ?? (existsSync(defaultDashboardDir) ? defaultDashboardDir : undefined)
  const managementRuntime = await createManagementApi({ database, actions, port: config.managementPort ?? DEFAULT_MANAGEMENT_PORT, dashboardDir })
  let closed = false

  return {
    database, mcpUrl: mcpRuntime.url, managementUrl: managementRuntime.url,
    async close() {
      if (closed) return
      closed = true
      await managementRuntime.close().catch(() => undefined)
      await mcpRuntime.close().catch(() => undefined)
      for (const client of clients.values()) await client.close().catch(() => undefined)
      clients.clear()
      for (const worker of database.workers.listWorkers()) await workerManager.stopWorker(worker.id).catch(() => undefined)
      database.close()
    },
  }
}
