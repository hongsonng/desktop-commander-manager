import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { startManager, type ManagerRuntime } from '../../apps/server/src/main.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('State Owner Database Rollback and Cross-Language Portability', () => {
  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  it(
    'preserves data and session bindings across Node -> Rust -> Node ownership transitions',
    async () => {
      if (!existsSync(exePath)) {
        console.warn('Skipping test: dcm-manager.exe not built yet')
        return
      }

      const root = mkdtempSync(join(tmpdir(), 'dcm-state-rollback-'))
      roots.push(root)
      const dbPath = join(root, 'manager.db')
      const runtimeRoot = join(root, 'workers')

      process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.RollbackTest.${process.pid}`

      const rpc = async (url: string, method: string, id: string | number, params: Record<string, unknown>) => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        })
        return { status: res.status, body: (await res.json()) as Record<string, any> }
      }

      // ==========================================
      // PHASE 1: Node owns state
      // ==========================================
      const nodeRuntime: ManagerRuntime = await startManager({
        databasePath: dbPath,
        runtimeRoot,
        mcpPort: 0,
        managementPort: 0,
        platformOwner: 'rust',
        workerOwner: 'rust',
        stateOwner: 'node',
        nativeSidecarPath: exePath,
      })

      let nodeBoundWorker: string
      try {
        const envelope = {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'openai/session': 'session-node-created',
        }
        const call = await rpc(nodeRuntime.mcpUrl, 'tools/call', 1, {
          name: 'get_config',
          arguments: {},
          _meta: envelope,
        })
        expect(call.status).toBe(200)

        const sessions = await (await fetch(`${nodeRuntime.managementUrl}/api/sessions`)).json() as Array<{ sessionId: string; workerId: string }>
        expect(sessions).toHaveLength(1)
        expect(sessions[0].sessionId).toBe('session-node-created')
        nodeBoundWorker = sessions[0].workerId
      } finally {
        await nodeRuntime.close()
      }

      // ==========================================
      // PHASE 2: Transition to Rust state owner
      // ==========================================
      const rustRuntime: ManagerRuntime = await startManager({
        databasePath: dbPath,
        runtimeRoot,
        mcpPort: 0,
        managementPort: 0,
        platformOwner: 'rust',
        workerOwner: 'rust',
        stateOwner: 'rust',
        nativeSidecarPath: exePath,
      })

      try {
        // Verify Node-created session is read by Rust
        const sessionsInRust = await (await fetch(`${rustRuntime.managementUrl}/api/sessions`)).json() as Array<{ sessionId: string; workerId: string }>
        const existingSession = sessionsInRust.find((s) => s.sessionId === 'session-node-created')
        expect(existingSession).toBeDefined()
        expect(existingSession?.workerId).toBe(nodeBoundWorker)

        // Rust creates its own session binding
        const rustEnvelope = {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'openai/session': 'session-rust-created',
        }
        const call = await rpc(rustRuntime.mcpUrl, 'tools/call', 2, {
          name: 'get_config',
          arguments: {},
          _meta: rustEnvelope,
        })
        expect(call.status).toBe(200)

        const allRustSessions = await (await fetch(`${rustRuntime.managementUrl}/api/sessions`)).json() as Array<{ sessionId: string; workerId: string }>
        expect(allRustSessions).toHaveLength(2)
      } finally {
        await rustRuntime.close()
      }

      // ==========================================
      // PHASE 3: Rollback / reopen under Node
      // ==========================================
      const nodeReopened: ManagerRuntime = await startManager({
        databasePath: dbPath,
        runtimeRoot,
        mcpPort: 0,
        managementPort: 0,
        platformOwner: 'rust',
        workerOwner: 'rust',
        stateOwner: 'node',
        nativeSidecarPath: exePath,
      })

      try {
        // Assert all data from both phases is intact and readable under Node
        const finalSessions = await (await fetch(`${nodeReopened.managementUrl}/api/sessions`)).json() as Array<{ sessionId: string; workerId: string }>
        expect(finalSessions).toHaveLength(2)
        const sessionIds = finalSessions.map((s) => s.sessionId)
        expect(sessionIds).toContain('session-node-created')
        expect(sessionIds).toContain('session-rust-created')

        const finalWorkers = await (await fetch(`${nodeReopened.managementUrl}/api/workers`)).json() as Array<{ id: string; status: string }>
        expect(finalWorkers).toHaveLength(2)
        expect(finalWorkers.every((w) => w.status === 'READY')).toBe(true)

        const finalToolCalls = await (await fetch(`${nodeReopened.managementUrl}/api/tool-calls`)).json() as Array<{ sessionId: string; toolName: string }>
        expect(finalToolCalls.length).toBeGreaterThanOrEqual(2)
      } finally {
        await nodeReopened.close()
      }
    },
    30000,
  )
})
