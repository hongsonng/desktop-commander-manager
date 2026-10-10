import type { EventRecord, SessionBinding, WorkerDescriptor, WorkerRecord } from '@dc-manager/shared'
import type { EventInput, ManagerStateProvider } from './manager-state.js'
import type { NativeSidecarClient } from './native-sidecar.js'

export class RustManagerStateProvider implements ManagerStateProvider {
  constructor(private readonly sidecar: NativeSidecarClient) {}

  async getWorker(id: string): Promise<WorkerRecord | undefined> {
    return this.sidecar.stateGetWorker(id)
  }

  async listWorkers(): Promise<WorkerDescriptor[]> {
    return this.sidecar.stateListWorkers()
  }

  async listSessions(): Promise<SessionBinding[]> {
    return this.sidecar.stateListSessions()
  }

  async listEvents(limit?: number): Promise<EventRecord[]> {
    return this.sidecar.stateListEvents(limit)
  }

  async appendEvent(event: EventInput): Promise<EventRecord> {
    return this.sidecar.stateAppendEvent(event)
  }
}
