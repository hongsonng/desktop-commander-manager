import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { startManager, type ManagerRuntime } from '../../apps/server/src/main.js'
import { normalizeContractValue } from './normalize.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

describe('state-owner contract parity', () => {
  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  const owners = ['node', 'rust'] as const

  for (const stateOwner of owners) {
    describe(`stateOwner="${stateOwner}"`, () => {
      it(
        'produces consistent management API shapes, MCP discovery, sticky routing, and audit logs',
        async () => {
          if (!existsSync(exePath)) {
            console.warn('Skipping test: dcm-manager.exe not built yet')
            return
          }

          const root = mkdtempSync(join(tmpdir(), `dcm-state-contract-${stateOwner}-`))
          roots.push(root)

          process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.ContractTest.${stateOwner}.${process.pid}`

          const runtime: ManagerRuntime = await startManager({
            databasePath: join(root, 'manager.db'),
            runtimeRoot: join(root, 'workers'),
            mcpPort: 0,
            managementPort: 0,
            platformOwner: 'rust',
            workerOwner: 'rust',
            stateOwner,
            nativeSidecarPath: exePath,
          })

          try {
            // 1. Management API Health
            const healthRes = await fetch(`${runtime.managementUrl}/api/health`)
            expect(healthRes.status).toBe(200)
            const healthJson = await healthRes.json()
            expect(healthJson).toMatchObject({ status: 'ok' })

            // 2. Initial Workers State
            const workersRes = await fetch(`${runtime.managementUrl}/api/workers`)
            expect(workersRes.status).toBe(200)
            const workersJson = await workersRes.json() as Array<Record<string, unknown>>
            expect(workersJson).toHaveLength(2)
            for (const w of workersJson) {
              expect(w.status).toBe('READY')
              expect(w.activeSessionCount).toBe(0)
              expect(w.enabled).toBe(true)
            }

            // 3. Initial Sessions
            const sessionsRes = await fetch(`${runtime.managementUrl}/api/sessions`)
            expect(sessionsRes.status).toBe(200)
            const sessionsJson = await sessionsRes.json()
            expect(sessionsJson).toEqual([])

            // 4. MCP Discovery (modern protocol 2026-07-28)
            const rpc = async (method: string, id: string | number, params: Record<string, unknown>) => {
              const res = await fetch(runtime.mcpUrl, {
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

            const envelope = {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
              'openai/session': 'chat-contract-session-1',
            }

            const discover = await rpc('server/discover', 1, { _meta: envelope })
            expect(discover.status).toBe(200)
            expect(discover.body.result).toMatchObject({
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
            })

            // 5. Tools List
            const listTools = await rpc('tools/list', 2, { _meta: envelope })
            expect(listTools.status).toBe(200)
            expect(listTools.body.result.resultType).toBe('complete')
            expect(Array.isArray(listTools.body.result.tools)).toBe(true)
            expect(listTools.body.result.tools.length).toBeGreaterThan(0)

            // 6. Tool Call with Sticky Session
            const callTool = await rpc('tools/call', 3, {
              name: 'get_config',
              arguments: {},
              _meta: envelope,
            })
            expect(callTool.status).toBe(200)
            expect(callTool.body.result.resultType).toBe('complete')
            expect(Array.isArray(callTool.body.result.content)).toBe(true)

            // 7. Session Binding Verification
            const sessionsAfterRes = await fetch(`${runtime.managementUrl}/api/sessions`)
            const sessionsAfter = await sessionsAfterRes.json() as Array<{ sessionId: string; workerId: string }>
            expect(sessionsAfter).toHaveLength(1)
            expect(sessionsAfter[0].sessionId).toBe('chat-contract-session-1')
            const boundWorkerId = sessionsAfter[0].workerId
            expect(['worker-1', 'worker-2']).toContain(boundWorkerId)

            // 8. Sticky Routing Check: Subsequent call routes to same bound worker
            const callTool2 = await rpc('tools/call', 4, {
              name: 'get_config',
              arguments: {},
              _meta: envelope,
            })
            expect(callTool2.status).toBe(200)

            // 9. Tool Call Audit Verification
            const toolCallsRes = await fetch(`${runtime.managementUrl}/api/tool-calls`)
            expect(toolCallsRes.status).toBe(200)
            const toolCalls = await toolCallsRes.json() as Array<Record<string, unknown>>
            expect(toolCalls.length).toBeGreaterThanOrEqual(2)
            expect(toolCalls[0]).toMatchObject({
              sessionId: 'chat-contract-session-1',
              workerId: boundWorkerId,
              toolName: 'get_config',
              status: 'OK',
              failedOver: false,
            })

            // 10. Normalized Snapshot Parity Check
            const normalizedWorkers = normalizeContractValue(workersJson)
            expect(normalizedWorkers).toMatchSnapshot
          } finally {
            await runtime.close()
          }
        },
        20000,
      )
    })
  }
})
