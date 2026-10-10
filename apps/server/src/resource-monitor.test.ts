import { describe, expect, it, vi } from 'vitest'
import {
  createResourceMonitor,
  type RawSnapshot,
  type ResourceCollector,
} from './resource-monitor.js'

describe('ResourceMonitor collector ownership', () => {
  const fakeNodeSnapshot: RawSnapshot = {
    manager: { rootPid: 100, memoryBytes: 50_000_000, cpuSeconds: 1.5, processCount: 1 },
    tunnel: { rootPid: null, memoryBytes: 0, cpuSeconds: 0, processCount: 0 },
    workers: [{ rootPid: 200, memoryBytes: 30_000_000, cpuSeconds: 0.8, processCount: 1 }],
  }

  const fakeRustSnapshot: RawSnapshot = {
    manager: { rootPid: 100, memoryBytes: 51_000_000, cpuSeconds: 1.55, processCount: 1 },
    tunnel: { rootPid: null, memoryBytes: 0, cpuSeconds: 0, processCount: 0 },
    workers: [{ rootPid: 200, memoryBytes: 31_000_000, cpuSeconds: 0.85, processCount: 1 }],
  }

  it('owner "node" calls only nodeCollector', async () => {
    const nodeCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeNodeSnapshot),
    }
    const rustCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeRustSnapshot),
    }

    const monitor = createResourceMonitor(
      () => [{ id: 'worker-1', name: 'Worker 1', pid: 200 }],
      { owner: 'node', nodeCollector, rustCollector },
    )

    const result = await monitor.snapshot()

    expect(nodeCollector.collect).toHaveBeenCalledTimes(1)
    expect(rustCollector.collect).not.toHaveBeenCalled()
    expect(result.available).toBe(true)
    expect(result.items.find((i) => i.id === 'manager')?.memoryBytes).toBe(50_000_000)
  })

  it('owner "rust" calls only rustCollector', async () => {
    const nodeCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeNodeSnapshot),
    }
    const rustCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeRustSnapshot),
    }

    const monitor = createResourceMonitor(
      () => [{ id: 'worker-1', name: 'Worker 1', pid: 200 }],
      { owner: 'rust', nodeCollector, rustCollector },
    )

    const result = await monitor.snapshot()

    expect(nodeCollector.collect).not.toHaveBeenCalled()
    expect(rustCollector.collect).toHaveBeenCalledTimes(1)
    expect(result.available).toBe(true)
    expect(result.items.find((i) => i.id === 'manager')?.memoryBytes).toBe(51_000_000)
  })

  it('owner "shadow" returns node result, calls rust, and compares without failing on shadow error', async () => {
    const nodeCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeNodeSnapshot),
    }
    const rustCollector: ResourceCollector = {
      collect: vi.fn().mockRejectedValue(new Error('Rust sampler transient error')),
    }
    const onShadowComparison = vi.fn()

    const monitor = createResourceMonitor(
      () => [{ id: 'worker-1', name: 'Worker 1', pid: 200 }],
      { owner: 'shadow', nodeCollector, rustCollector, onShadowComparison },
    )

    const result = await monitor.snapshot()

    expect(nodeCollector.collect).toHaveBeenCalledTimes(1)
    expect(rustCollector.collect).toHaveBeenCalledTimes(1)
    // Response must still succeed with Node result!
    expect(result.available).toBe(true)
    expect(result.items.find((i) => i.id === 'manager')?.memoryBytes).toBe(50_000_000)
  })

  it('owner "shadow" fires onShadowComparison when both collectors succeed', async () => {
    const nodeCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeNodeSnapshot),
    }
    const rustCollector: ResourceCollector = {
      collect: vi.fn().mockResolvedValue(fakeRustSnapshot),
    }
    const onShadowComparison = vi.fn()

    const monitor = createResourceMonitor(
      () => [{ id: 'worker-1', name: 'Worker 1', pid: 200 }],
      { owner: 'shadow', nodeCollector, rustCollector, onShadowComparison },
    )

    await monitor.snapshot()
    // Allow microtask to resolve
    await new Promise((r) => setTimeout(r, 10))

    expect(onShadowComparison).toHaveBeenCalledTimes(1)
    const comparison = onShadowComparison.mock.calls[0][0]
    expect(comparison.node).toEqual(fakeNodeSnapshot)
    expect(comparison.rust).toEqual(fakeRustSnapshot)
    expect(comparison.match.managerCountMatch).toBe(true)
  })
})
