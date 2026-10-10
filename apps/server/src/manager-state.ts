import type { EventRecord, SessionBinding, WorkerDescriptor, WorkerRecord } from '@dc-manager/shared'

export type EventInput = Omit<EventRecord, 'id'>

export interface ManagerStateProvider {
  getWorker(id: string): Promise<WorkerRecord | undefined>
  listWorkers(): Promise<WorkerDescriptor[]>
  listSessions(): Promise<SessionBinding[]>
  listEvents(limit?: number): Promise<EventRecord[]>
  appendEvent(event: EventInput): Promise<EventRecord>
}
