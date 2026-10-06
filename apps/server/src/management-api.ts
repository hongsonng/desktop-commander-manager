import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ManagerDatabase } from '@dc-manager/database'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import type { ResourceUsageSnapshot } from './resource-monitor.js'

export interface ManagementActions {
  restart(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
}

export interface ConnectionInfo {
  mode: 'direct-local'
  mcpUrl: string
  workerStrategy: 'sticky-failover'
}

type ToolCallMetadata = {
  toolName?: unknown
  argsSummary?: unknown
  status?: unknown
  durationMs?: unknown
  failedOver?: unknown
  error?: unknown
}

function parseToolCallMetadata(value: string | null): ToolCallMetadata {
  if (!value) return {}
  try { return JSON.parse(value) as ToolCallMetadata } catch { return {} }
}

type Options = {
  database: ManagerDatabase
  actions: ManagementActions
  connectionInfo?: ConnectionInfo
  port?: number
  dashboardDir?: string
  resources?: { snapshot(): Promise<ResourceUsageSnapshot> }
}

export async function createManagementApi(options: Options): Promise<{ url: string; close(): Promise<void> }> {
  const app = Fastify({ logger: false })
  const startedAt = Date.now()

  app.get('/api/health', async () => ({ status: 'ok', startedAt: new Date(startedAt).toISOString(), uptimeMs: Date.now() - startedAt }))
  app.get('/api/connection', async () => options.connectionInfo ?? ({
    mode: 'direct-local',
    mcpUrl: 'http://127.0.0.1:8787/mcp',
    workerStrategy: 'sticky-failover',
  } satisfies ConnectionInfo))
  app.get('/api/workers', async () => options.database.workers.listWorkers().map((worker) => ({ ...worker, activeSessionCount: options.database.sessions.countByWorker(worker.id) })))
  app.get('/api/resources', async () => options.resources?.snapshot() ?? ({
    available: false,
    sampledAt: new Date().toISOString(),
    total: { memoryBytes: 0, cpuPercent: 0 },
    system: { memoryUsedBytes: 0, totalMemoryBytes: 0, cpuPercent: 0 },
    items: [],
  } satisfies ResourceUsageSnapshot))
  app.get('/api/sessions', async () => options.database.sessions.listSessions())
  app.get('/api/events', async () => options.database.events.listEvents(200).filter((event) => event.type !== 'TOOL_CALL').slice(0, 100))
  app.get('/api/tool-calls', async () => options.database.events.listEvents(500)
    .filter((event) => event.type === 'TOOL_CALL')
    .slice(0, 100)
    .map((event) => {
      const metadata = parseToolCallMetadata(event.metadataJson)
      return {
        id: event.id,
        sessionId: event.sessionId,
        workerId: event.workerId,
        toolName: typeof metadata.toolName === 'string' ? metadata.toolName : event.message.split(' ')[0] ?? 'unknown',
        argsSummary: typeof metadata.argsSummary === 'string' ? metadata.argsSummary : '',
        status: metadata.status === 'ERROR' ? 'ERROR' : 'OK',
        durationMs: typeof metadata.durationMs === 'number' ? metadata.durationMs : 0,
        failedOver: metadata.failedOver === true,
        error: typeof metadata.error === 'string' ? metadata.error : null,
        createdAt: event.createdAt,
      }
    }))

  for (const action of ['restart', 'enable', 'disable'] as const) {
    app.post(`/api/workers/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!options.database.workers.getWorker(id)) return reply.code(404).send({ error: 'WORKER_NOT_FOUND', workerId: id })
      await options.actions[action](id)
      return options.database.workers.getWorker(id)
    })
  }

  if (options.dashboardDir && existsSync(options.dashboardDir)) {
    await app.register(fastifyStatic, { root: resolve(options.dashboardDir), prefix: '/' })
  }

  const address = await app.listen({ host: '127.0.0.1', port: options.port ?? 8788 })
  return { url: address, async close() { await app.close() } }
}
