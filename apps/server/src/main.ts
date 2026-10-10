import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createDatabase, type ManagerDatabase } from '@dc-manager/database'
import { WorkerClient, type ProxyWorkerClient } from '@dc-manager/mcp-proxy'
import { RetryPolicy, SessionRouter, UpstreamCallError } from '@dc-manager/router'
import type { WorkerRecord } from '@dc-manager/shared'
import {
  WorkerManager,
  buildWorkerEnvironment,
  createDesktopCommanderProcessFactory,
  resolveDesktopCommanderSpawnSpec,
  type DesktopCommanderProcessFactory,
  type WorkerProcessHandle,
} from '@dc-manager/worker-manager'
import { createMcpHttpServer } from './mcp-server.js'
import { createManagementApi } from './management-api.js'
import {
  NativeSidecarClient,
  NativeSidecarWorkerClient,
} from './native-sidecar.js'
import {
  createNativeResourceCollector,
  createResourceMonitor,
} from './resource-monitor.js'
import { DEFAULT_MANAGEMENT_PORT, DEFAULT_MCP_PORT, type ManagerConfig } from './config.js'
import type { ManagerStateProvider } from './manager-state.js'
import { NodeManagerStateProvider } from './node-manager-state.js'
import { RustManagerStateProvider } from './rust-manager-state.js'
import type { McpProxyBackend } from './mcp-proxy-backend.js'
import { NodeMcpProxyBackend } from './node-mcp-proxy-backend.js'
import { RustMcpProxyBackend } from './rust-mcp-proxy-backend.js'

interface WorkerClientFactory {
  connect(handle: WorkerProcessHandle, workerId: string): Promise<ProxyWorkerClient>
}

type Overrides = {
  processFactory?: DesktopCommanderProcessFactory
  workerClientFactory?: WorkerClientFactory
  sidecarClient?: NativeSidecarClient
}

export interface ManagerRuntime {
  state: ManagerStateProvider
  database?: ManagerDatabase
  mcpUrl: string
  managementUrl: string
  close(): Promise<void>
}

function defaultWorker(id: string, now: string): WorkerRecord {
  return { id, name: id === 'worker-1' ? 'Worker 1' : 'Worker 2', enabled: true, status: 'STOPPED', pid: null, failureCount: 0, lastHeartbeatAt: null, createdAt: now, updatedAt: now }
}

export function resolveSidecarExecutablePath(configured?: string): string {
  if (configured && existsSync(configured)) return configured
  const candidates = [
    configured,
    resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe'),
    resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe'),
    resolve(process.cwd(), 'bin', 'dcm-manager.exe'),
    resolve(process.cwd(), 'dcm-manager.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  return configured ?? resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
}

export async function startManager(config: ManagerConfig, overrides: Overrides = {}): Promise<ManagerRuntime> {
  const platformOwner = config.platformOwner ?? 'node'
  const workerOwner = config.workerOwner ?? 'node'
  const stateOwner = config.stateOwner ?? 'node'
  const managementApiOwner = config.managementApiOwner ?? 'node'

  if (managementApiOwner === 'rust') {
    if (stateOwner !== 'rust') {
      throw new Error('managementApiOwner="rust" requires stateOwner="rust"')
    }
    if (workerOwner !== 'rust') {
      throw new Error('managementApiOwner="rust" requires workerOwner="rust"')
    }
  }

  if (stateOwner === 'rust' && workerOwner !== 'rust') {
    throw new Error('stateOwner="rust" requires workerOwner="rust"')
  }

  let sidecarClient = overrides.sidecarClient ?? null
  const shouldCloseSidecar = !overrides.sidecarClient

  if (
    !sidecarClient &&
    (platformOwner === 'rust' ||
      platformOwner === 'shadow' ||
      workerOwner === 'rust' ||
      workerOwner === 'shadow' ||
      stateOwner === 'rust' ||
      managementApiOwner === 'rust')
  ) {
    const sidecarPath = resolveSidecarExecutablePath(config.nativeSidecarPath)
    if (
      (platformOwner === 'rust' ||
        workerOwner === 'rust' ||
        stateOwner === 'rust' ||
        managementApiOwner === 'rust') &&
      !existsSync(sidecarPath)
    ) {
      throw new Error(`Native sidecar executable not found at "${sidecarPath}"`)
    }
    try {
      sidecarClient = await NativeSidecarClient.start(sidecarPath, {
        DCM_RUNTIME_ROOT: config.runtimeRoot,
      })
    } catch (sidecarErr) {
      if (
        platformOwner === 'rust' ||
        workerOwner === 'rust' ||
        stateOwner === 'rust' ||
        managementApiOwner === 'rust'
      ) {
        throw new Error(
          `Failed to start native sidecar for owner="rust": ${sidecarErr}`,
        )
      } else {
        console.warn(
          `[startManager] Native sidecar failed to start in shadow mode: ${sidecarErr}`,
        )
      }
    }
  }

  mkdirSync(dirname(config.databasePath), { recursive: true })
  mkdirSync(config.runtimeRoot, { recursive: true })

  let database: ManagerDatabase | undefined
  let state: ManagerStateProvider
  let proxyBackend: McpProxyBackend
  let actions: {
    restart(id: string): Promise<void>
    enable(id: string): Promise<void>
    disable(id: string): Promise<void>
  }
  let workerManager: WorkerManager | undefined
  const clients = new Map<string, ProxyWorkerClient>()

  if (stateOwner === 'rust') {
    if (!sidecarClient) {
      throw new Error('Native sidecar client is required when stateOwner is "rust"')
    }
    await sidecarClient.backendOpen(config.databasePath, config.runtimeRoot)
    state = new RustManagerStateProvider(sidecarClient)
    proxyBackend = new RustMcpProxyBackend(sidecarClient)

    actions = {
      async restart(id: string) {
        await sidecarClient!.stateSetWorkerEnabled(id, true)
        await sidecarClient!.workerRestart({ workerId: id })
      },
      async enable(id: string) {
        await sidecarClient!.stateSetWorkerEnabled(id, true)
        await sidecarClient!.workerRestart({ workerId: id })
      },
      async disable(id: string) {
        await sidecarClient!.workerStop({ workerId: id })
        await sidecarClient!.stateSetWorkerEnabled(id, false)
      },
    }
  } else {
    const nodeDb = createDatabase(config.databasePath)
    database = nodeDb
    nodeDb.reconcileRuntimeState()
    if (nodeDb.workers.listWorkers().length === 0) {
      const now = new Date().toISOString()
      nodeDb.workers.upsertWorker(defaultWorker('worker-1', now))
      nodeDb.workers.upsertWorker(defaultWorker('worker-2', now))
    }
    state = new NodeManagerStateProvider(nodeDb)

    let routableWorkers: {
      getHealthyWorkers(): ReturnType<WorkerManager['getHealthyWorkers']>
      restartWorker(id: string): Promise<void>
    }

    if (workerOwner === 'rust') {
      if (!sidecarClient) {
        throw new Error('Native sidecar client is required when workerOwner is "rust"')
      }

    const stateMap: Record<string, 'READY' | 'BUSY' | 'DEGRADED' | 'STOPPED' | 'OFFLINE' | 'DISABLED' | 'STARTING'> = {
      READY: 'READY',
      BUSY: 'BUSY',
      DEGRADED: 'DEGRADED',
      STOPPED: 'STOPPED',
      OFFLINE: 'OFFLINE',
      DISABLED: 'DISABLED',
      STARTING: 'STARTING',
    }

    sidecarClient.onWorkerStateChanged((event) => {
      if (event.state === 'BUSY') return
      const mappedStatus = stateMap[event.state] ?? 'DEGRADED'
      nodeDb.workers.setWorkerState(event.workerId, {
        status: mappedStatus,
        pid: event.pid ?? null,
        ...(mappedStatus === 'READY' ? { lastHeartbeatAt: new Date().toISOString() } : {}),
      })
      nodeDb.events.appendEvent({
        sessionId: null,
        workerId: event.workerId,
        type: `WORKER_${event.state}`,
        message: event.reason ?? `${event.workerId} transitioned to ${event.state}`,
        metadataJson: JSON.stringify({
          pid: event.pid,
          exitCode: event.exitCode,
        }),
        createdAt: new Date().toISOString(),
      })
    })

    const startRustWorker = async (workerId: string): Promise<void> => {
      const runtimeDir = join(config.runtimeRoot, workerId)
      const spec = resolveDesktopCommanderSpawnSpec(process.cwd())
      const customCommand = process.env.DCM_WORKER_COMMAND
      const customArgs = process.env.DCM_WORKER_ARGS
        ? JSON.parse(process.env.DCM_WORKER_ARGS)
        : undefined
      const command = customCommand ?? spec.command
      const args = customArgs ?? spec.args
      const env = buildWorkerEnvironment(runtimeDir) as Record<string, string>

      const handle = await sidecarClient!.workerStart({
        workerId,
        runtimeDir,
        command,
        args,
        env,
      })

      const client = new NativeSidecarWorkerClient(sidecarClient!, workerId)
      clients.set(workerId, client)
      nodeDb.workers.setWorkerState(workerId, {
        status: 'READY',
        pid: handle.pid,
        lastHeartbeatAt: new Date().toISOString(),
      })
    }

    for (const worker of nodeDb.workers.listWorkers().filter((item) => item.enabled)) {
      try {
        await startRustWorker(worker.id)
      } catch (err) {
        console.error(`[startRustWorker] Error starting ${worker.id}:`, err)
        nodeDb.workers.setWorkerState(worker.id, {
          status: 'OFFLINE',
          pid: null,
        })
      }
    }

    routableWorkers = {
      getHealthyWorkers: () =>
        nodeDb.workers
          .listWorkers()
          .filter((w) => w.enabled && (w.status === 'READY' || w.status === 'BUSY'))
          .map((w) => ({
            ...w,
            activeSessionCount: nodeDb.sessions.countByWorker(w.id),
          })),
      restartWorker: async (workerId: string) => {
        await sidecarClient!.workerRestart({ workerId })
      },
    }

    actions = {
      async restart(id: string) {
        await sidecarClient!.workerRestart({ workerId: id })
      },
      async enable(id: string) {
        const current = nodeDb.workers.getWorker(id)
        if (current) {
          nodeDb.workers.upsertWorker({
            ...current,
            enabled: true,
            status: 'STOPPED',
            updatedAt: new Date().toISOString(),
          })
        }
        await startRustWorker(id)
      },
      async disable(id: string) {
        await sidecarClient!.workerStop({ workerId: id })
        clients.delete(id)
        const current = nodeDb.workers.getWorker(id)
        if (current) {
          nodeDb.workers.upsertWorker({
            ...current,
            enabled: false,
            status: 'DISABLED',
            pid: null,
            updatedAt: new Date().toISOString(),
          })
        }
      },
    }
  } else {
    // Node supervisor authoritative (with optional shadow sidecar monitoring)
    const processFactory = overrides.processFactory ?? createDesktopCommanderProcessFactory()
    const workerClientFactory: WorkerClientFactory = overrides.workerClientFactory ?? { connect: (handle) => WorkerClient.connect(handle) }
    workerManager = new WorkerManager({ database: nodeDb, processFactory, runtimeRoot: config.runtimeRoot })

    const connectWorker = async (workerId: string, handle: WorkerProcessHandle): Promise<void> => {
      try {
        const client = await workerClientFactory.connect(handle, workerId)
        clients.set(workerId, client)
        workerManager!.markReady(workerId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await workerManager!.degradeWorker(workerId, message)
        nodeDb.events.appendEvent({ sessionId: null, workerId, type: 'WORKER_HANDSHAKE_FAILED', message, metadataJson: null, createdAt: new Date().toISOString() })
      }
    }

    for (const worker of nodeDb.workers.listWorkers().filter((item) => item.enabled)) {
      try { await connectWorker(worker.id, await workerManager.startWorker(worker.id)) } catch { /* WorkerManager persisted OFFLINE */ }
    }

    const recoverWorker = async (workerId: string): Promise<void> => {
      await clients.get(workerId)?.close().catch(() => undefined)
      clients.delete(workerId)
      await connectWorker(workerId, await workerManager!.restartWorker(workerId))
    }

    routableWorkers = {
      getHealthyWorkers: () => workerManager!.getHealthyWorkers(),
      restartWorker: recoverWorker,
    }

    actions = {
      async restart(id: string) {
        await recoverWorker(id)
      },
      async enable(id: string) {
        workerManager!.enableWorker(id)
        await connectWorker(id, await workerManager!.startWorker(id))
      },
      async disable(id: string) {
        await clients.get(id)?.close().catch(() => undefined); clients.delete(id)
        await workerManager!.disableWorker(id)
      },
    }
  }

  const sessionRouter = new SessionRouter({ database: nodeDb, workerManager: routableWorkers })
  const retryPolicy = new RetryPolicy()
  proxyBackend = new NodeMcpProxyBackend(sessionRouter, retryPolicy, (workerId) => {
    const client = clients.get(workerId)
    if (!client) throw new UpstreamCallError('PRE_DISPATCH', `Worker client is not connected: ${workerId}`)
    return client
  })
}

  const mcpRuntime = await createMcpHttpServer({
    host: '127.0.0.1',
    port: config.mcpPort ?? DEFAULT_MCP_PORT,
    proxyBackend,
    onToolCall(audit) {
      state.appendEvent({
        sessionId: audit.sessionId,
        workerId: audit.workerId,
        type: 'TOOL_CALL',
        message: `${audit.toolName} ${audit.status}`,
        metadataJson: JSON.stringify({
          toolName: audit.toolName,
          argsSummary: audit.argsSummary,
          status: audit.status,
          durationMs: audit.durationMs,
          failedOver: audit.failedOver,
          ...(audit.error ? { error: audit.error } : {}),
        }),
        createdAt: new Date().toISOString(),
      }).catch((auditErr) => {
        console.warn('[onToolCall] Failed to append tool call audit event:', auditErr)
      })
    },
  })

  const rustCollector = sidecarClient ? createNativeResourceCollector(sidecarClient) : undefined
  const resourceMonitor = createResourceMonitor(
    async () => (await state.listWorkers()).map((worker) => ({ id: worker.id, name: worker.name, pid: worker.pid })),
    {
      owner: platformOwner,
      rustCollector,
    },
  )

  const defaultDashboardDir = resolve(process.cwd(), 'apps', 'dashboard', 'dist')
  const dashboardDir = config.dashboardDir ?? (existsSync(defaultDashboardDir) ? defaultDashboardDir : undefined)

  let managementUrl: string
  let closeManagement: () => Promise<void>

  if (managementApiOwner === 'rust') {
    if (!sidecarClient) {
      throw new Error('Native sidecar client is required when managementApiOwner is "rust"')
    }
    const startResult = await sidecarClient.managementStart({
      host: '127.0.0.1',
      port: config.managementPort ?? DEFAULT_MANAGEMENT_PORT,
      dashboardDir,
      mcpUrl: mcpRuntime.url,
    })
    managementUrl = startResult.url
    closeManagement = async () => {
      await sidecarClient!.managementStop()
    }
  } else {
    const managementRuntime = await createManagementApi({
      state,
      database,
      actions,
      connectionInfo: {
        mode: 'direct-local',
        mcpUrl: mcpRuntime.url,
        workerStrategy: 'sticky-failover',
      },
      port: config.managementPort ?? DEFAULT_MANAGEMENT_PORT,
      dashboardDir,
      resources: resourceMonitor,
    })
    managementUrl = managementRuntime.url
    closeManagement = async () => {
      await managementRuntime.close()
    }
  }
  let closed = false

  return {
    state,
    database,
    mcpUrl: mcpRuntime.url,
    managementUrl,
    async close() {
      if (closed) return
      closed = true
      await closeManagement().catch(() => undefined)
      await mcpRuntime.close().catch(() => undefined)
      for (const client of clients.values()) await client.close().catch(() => undefined)
      clients.clear()
      if (stateOwner === 'rust') {
        if (sidecarClient) {
          await sidecarClient.backendClose().catch(() => undefined)
        }
      } else {
        if (workerManager) {
          for (const worker of database!.workers.listWorkers()) await workerManager.stopWorker(worker.id).catch(() => undefined)
        } else if (sidecarClient) {
          await sidecarClient.workerShutdownAll().catch(() => undefined)
        }
        database!.close()
      }
      if (sidecarClient && shouldCloseSidecar) {
        await sidecarClient.close().catch(() => undefined)
      }
    },
  }
}
