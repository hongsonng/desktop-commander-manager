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

  const testEnv = {
    DCM_SUPERVISOR_MUTEX_NAME: `Local\\DesktopCommanderManager.TestSidecar.${process.pid}`,
  }

  it('rejects worker operations for unknown worker with UpstreamCallError', async () => {
    if (!existsSync(exePath)) return

    const client = await NativeSidecarClient.start(exePath, testEnv)
    await expect(
      client.workerStart({
        workerId: 'non-existent-worker',
        runtimeDir: '',
        command: '',
        args: [],
      }),
    ).rejects.toThrow(/Worker not found/i)

    await client.close()
  })

  it('executes worker lifecycle and tools via NativeSidecarWorkerClient', async () => {
    if (!existsSync(exePath)) return

    const client = await NativeSidecarClient.start(exePath, testEnv)
    const events: string[] = []
    const unsub = client.onWorkerStateChanged((event) => {
      events.push(event.state)
    })

    const script = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test' } }
          }));
        } else if (req.method === 'tools/list') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { tools: [{ name: 'test-tool' }] }
          }));
        } else if (req.method === 'tools/call') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { content: [{ type: 'text', text: 'sidecar-ok' }], isError: false }
          }));
        }
      });
    `

    const runtimeDir = join(process.cwd(), 'data', 'test-sidecar-worker')
    const handle = await client.workerStart({
      workerId: 'mock-sidecar-worker',
      runtimeDir,
      command: process.execPath,
      args: ['-e', script],
    })

    expect(handle.workerId).toBe('mock-sidecar-worker')
    expect(handle.pid).toBeGreaterThan(0)

    const listRes = await client.workerListTools({ workerId: 'mock-sidecar-worker' })
    expect(listRes.tools).toHaveLength(1)
    expect(listRes.tools[0].name).toBe('test-tool')

    const callRes = await client.workerCallTool({
      workerId: 'mock-sidecar-worker',
      name: 'test-tool',
      arguments: {},
    })
    expect(callRes.isError).toBe(false)
    expect(callRes.content[0].text).toBe('sidecar-ok')

    await client.workerStop({ workerId: 'mock-sidecar-worker' })
    unsub()

    expect(events).toContain('READY')
    expect(events).toContain('STOPPED')

    await client.close()
  })
})
