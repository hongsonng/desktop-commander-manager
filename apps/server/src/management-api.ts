import type { ManagerDatabase } from '@dc-manager/database'
import Fastify from 'fastify'

export interface ManagementActions {
  restart(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
}

type Options = {
  database: ManagerDatabase
  actions: ManagementActions
  port?: number
}

export async function createManagementApi(options: Options): Promise<{ url: string; close(): Promise<void> }> {
  const app = Fastify({ logger: false })
  const startedAt = Date.now()

  app.get('/api/health', async () => ({ status: 'ok', startedAt: new Date(startedAt).toISOString(), uptimeMs: Date.now() - startedAt }))
  app.get('/api/workers', async () => options.database.workers.listWorkers().map((worker) => ({ ...worker, activeSessionCount: options.database.sessions.countByWorker(worker.id) })))
  app.get('/api/sessions', async () => options.database.sessions.listSessions())
  app.get('/api/events', async () => options.database.events.listEvents())

  for (const action of ['restart', 'enable', 'disable'] as const) {
    app.post(`/api/workers/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string }
      if (!options.database.workers.getWorker(id)) return reply.code(404).send({ error: 'WORKER_NOT_FOUND', workerId: id })
      await options.actions[action](id)
      return options.database.workers.getWorker(id)
    })
  }

  const address = await app.listen({ host: '127.0.0.1', port: options.port ?? 8788 })
  return { url: address, async close() { await app.close() } }
}
