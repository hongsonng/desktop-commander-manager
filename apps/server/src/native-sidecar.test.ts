import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { NativeSidecarClient } from './native-sidecar.js'

describe('NativeSidecarClient', () => {
  const releaseExe = join(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = join(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  it('starts sidecar, handles process/identity, and closes cleanly', async () => {
    if (!existsSync(exePath)) {
      console.warn('Skipping test: dcm-manager.exe not built yet')
      return
    }

    const client = await NativeSidecarClient.start(exePath)
    const identity = await client.identity(process.pid)

    expect(identity).not.toBeNull()
    expect(identity?.pid).toBe(process.pid)
    expect(identity?.creationTime100ns).toBeGreaterThan(0)

    await client.close()

    // Request after close must reject
    await expect(client.identity(process.pid)).rejects.toThrow('closed')
  })

  it('performs process/snapshot returning manager, tunnel, and workers', async () => {
    if (!existsSync(exePath)) return

    const client = await NativeSidecarClient.start(exePath)
    const snapshot = await client.snapshot({
      managerPid: process.pid,
      workerPids: [],
      tunnelProfile: 'desktop-commander-manager',
    })

    expect(snapshot.manager).toBeDefined()
    expect(snapshot.manager.rootPid).toBe(process.pid)
    expect(snapshot.manager.processCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.manager.memoryBytes).toBeGreaterThan(0)
    expect(snapshot.tunnel).toBeDefined()
    expect(snapshot.workers).toEqual([])

    await client.close()
  })

  it('rejects when sidecar returns structured error', async () => {
    if (!existsSync(exePath)) return

    const client = await NativeSidecarClient.start(exePath)
    // Wrong creation time should yield structured PLATFORM_ERROR
    await expect(
      client.killTree({
        pid: process.pid,
        expectedCreationTime100ns: 999999,
      }),
    ).rejects.toThrow(/identity mismatch/i)

    await client.close()
  })
})
