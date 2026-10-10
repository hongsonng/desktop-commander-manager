import { describe, expect, it, vi } from 'vitest'
import type { NativeSidecarClient } from './native-sidecar.js'
import { RustManagerStateProvider } from './rust-manager-state.js'

describe('RustManagerStateProvider', () => {
  it('delegates all state provider calls to the native sidecar client', async () => {
    const fakeSidecar = {
      stateGetWorker: vi.fn().mockResolvedValue({
        id: 'worker-1',
        name: 'Worker 1',
        enabled: true,
        status: 'READY',
        pid: 1234,
        failureCount: 0,
        lastHeartbeatAt: '2026-10-10T00:00:00.000Z',
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      }),
      stateListWorkers: vi.fn().mockResolvedValue([
        {
          id: 'worker-1',
          name: 'Worker 1',
          enabled: true,
          status: 'READY',
          pid: 1234,
          failureCount: 0,
          lastHeartbeatAt: '2026-10-10T00:00:00.000Z',
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
          activeSessionCount: 2,
        },
      ]),
      stateListSessions: vi.fn().mockResolvedValue([
        {
          sessionId: 'chat-1',
          workerId: 'worker-1',
          createdAt: '2026-10-10T00:00:00.000Z',
          lastUsedAt: '2026-10-10T00:00:00.000Z',
        },
      ]),
      stateListEvents: vi.fn().mockResolvedValue([
        {
          id: 1,
          sessionId: null,
          workerId: 'worker-1',
          type: 'WORKER_READY',
          message: 'ready',
          metadataJson: null,
          createdAt: '2026-10-10T00:00:00.000Z',
        },
      ]),
      stateAppendEvent: vi.fn().mockResolvedValue({
        id: 2,
        sessionId: 'chat-1',
        workerId: 'worker-1',
        type: 'TOOL_CALL',
        message: 'echo OK',
        metadataJson: null,
        createdAt: '2026-10-10T00:00:00.000Z',
      }),
    } as unknown as NativeSidecarClient

    const provider = new RustManagerStateProvider(fakeSidecar)

    const worker = await provider.getWorker('worker-1')
    expect(fakeSidecar.stateGetWorker).toHaveBeenCalledWith('worker-1')
    expect(worker?.id).toBe('worker-1')

    const workers = await provider.listWorkers()
    expect(fakeSidecar.stateListWorkers).toHaveBeenCalled()
    expect(workers).toHaveLength(1)
    expect(workers[0].activeSessionCount).toBe(2)

    const sessions = await provider.listSessions()
    expect(fakeSidecar.stateListSessions).toHaveBeenCalled()
    expect(sessions).toHaveLength(1)

    const events = await provider.listEvents(10)
    expect(fakeSidecar.stateListEvents).toHaveBeenCalledWith(10)
    expect(events).toHaveLength(1)

    const newEvent = await provider.appendEvent({
      sessionId: 'chat-1',
      workerId: 'worker-1',
      type: 'TOOL_CALL',
      message: 'echo OK',
      metadataJson: null,
      createdAt: '2026-10-10T00:00:00.000Z',
    })
    expect(fakeSidecar.stateAppendEvent).toHaveBeenCalled()
    expect(newEvent.id).toBe(2)
  })
})
