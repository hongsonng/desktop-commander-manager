import type { ManagerDatabase } from '@dc-manager/database'
import type { EventRecord, SessionBinding, WorkerDescriptor, WorkerRecord } from '@dc-manager/shared'
import type { EventInput, ManagerStateProvider } from './manager-state.js'

export class NodeManagerStateProvider implements ManagerStateProvider {
  constructor(private readonly database: ManagerDatabase) {}

  async getWorker(id: string): Promise<WorkerRecord | undefined> {
    return this.database.workers.getWorker(id)
  }

  async listWorkers(): Promise<WorkerDescriptor[]> {
    return this.database.workers.listWorkers().map((worker) => ({
      ...worker,
      activeSessionCount: this.database.sessions.countByWorker(worker.id),
    }))
  }

  async listSessions(): Promise<SessionBinding[]> {
    return this.database.sessions.listSessions()
  }

  async listEvents(limit?: number): Promise<EventRecord[]> {
    return this.database.events.listEvents(limit)
  }

  async appendEvent(event: EventInput): Promise<EventRecord> {
    return this.database.events.appendEvent(event)
  }
}
