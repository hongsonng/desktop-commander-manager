import { createHash } from 'node:crypto'
import type { ManagerDatabase } from '@dc-manager/database'
import type { RouteContext, WorkerDescriptor } from '@dc-manager/shared'

export interface RoutableWorkerManager {
  getHealthyWorkers(): WorkerDescriptor[]
  restartWorker(id: string): Promise<unknown>
}

export class NoHealthyWorkerError extends Error {
  readonly code = 'NO_HEALTHY_WORKER'
  constructor() { super('No healthy Desktop Commander worker is available') }
}

export function createFallbackSessionId(connectionId: string): string {
  return `fallback:${createHash('sha256').update(connectionId).digest('hex').slice(0, 24)}`
}

type Options = { database: ManagerDatabase; workerManager: RoutableWorkerManager }

export class SessionRouter {
  private tieCursor = 0
  constructor(private readonly options: Options) {}

  async resolve(context: RouteContext): Promise<WorkerDescriptor> {
    const now = new Date().toISOString()
    let sessionId = context.sessionId?.trim()
    if (!sessionId) {
      sessionId = createFallbackSessionId(context.connectionId)
      this.options.database.events.appendEvent({ sessionId, workerId: null, type: 'SESSION_KEY_MISSING', message: 'Using connection-scoped fallback session id', metadataJson: null, createdAt: now })
    }

    const binding = this.options.database.sessions.getSession(sessionId)
    if (binding) {
      const healthy = this.options.workerManager.getHealthyWorkers().find((worker) => worker.id === binding.workerId)
      if (healthy) {
        this.touch(binding.sessionId, binding.workerId, binding.createdAt, now)
        return healthy
      }

      try { await this.options.workerManager.restartWorker(binding.workerId) } catch { /* failover below */ }
      const recovered = this.options.workerManager.getHealthyWorkers().find((worker) => worker.id === binding.workerId)
      if (recovered) {
        this.touch(binding.sessionId, binding.workerId, binding.createdAt, now)
        return recovered
      }
      return this.failover(sessionId, binding.workerId)
    }

    const selected = this.selectHealthy()
    if (!selected) throw new NoHealthyWorkerError()
    this.options.database.sessions.upsertSession({ sessionId, workerId: selected.id, createdAt: now, lastUsedAt: now })
    this.options.database.events.appendEvent({ sessionId, workerId: selected.id, type: 'SESSION_BOUND', message: `Bound session to ${selected.id}`, metadataJson: null, createdAt: now })
    return selected
  }

  async failover(sessionId: string, failedWorkerId: string): Promise<WorkerDescriptor> {
    const selected = this.selectHealthy(failedWorkerId)
    if (!selected) throw new NoHealthyWorkerError()
    const now = new Date().toISOString()
    this.options.database.sessions.rebindSession(sessionId, selected.id, now)
    this.options.database.events.appendEvent({ sessionId, workerId: selected.id, type: 'SESSION_FAILOVER', message: `${failedWorkerId} -> ${selected.id}`, metadataJson: JSON.stringify({ from: failedWorkerId, to: selected.id }), createdAt: now })
    return selected
  }

  private selectHealthy(excludedWorkerId?: string): WorkerDescriptor | undefined {
    const workers = this.options.workerManager.getHealthyWorkers().filter((worker) => worker.id !== excludedWorkerId)
    if (!workers.length) return undefined
    const minSessions = Math.min(...workers.map((worker) => worker.activeSessionCount))
    const byLoad = workers.filter((worker) => worker.activeSessionCount === minSessions)
    const minFailures = Math.min(...byLoad.map((worker) => worker.failureCount))
    const tied = byLoad.filter((worker) => worker.failureCount === minFailures).sort((a, b) => a.id.localeCompare(b.id))
    if (tied.length === 1) return tied[0]
    const selected = tied[this.tieCursor % tied.length]
    this.tieCursor = (this.tieCursor + 1) % tied.length
    return selected
  }

  private touch(sessionId: string, workerId: string, createdAt: string, lastUsedAt: string): void {
    this.options.database.sessions.upsertSession({ sessionId, workerId, createdAt, lastUsedAt })
  }
}
