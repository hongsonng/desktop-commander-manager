import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

describe('management-api-owner contract parity', () => {
  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  const owners = ['node', 'rust'] as const

  for (const managementApiOwner of owners) {
    describe(`managementApiOwner="${managementApiOwner}"`, () => {
      it(
        'serves identical read endpoints, mutations, degraded tool calls, resources, and safe static assets',
        async () => {
          if (!existsSync(exePath)) {
            console.warn('Skipping test: dcm-manager.exe not built yet')
            return
          }

          const root = mkdtempSync(join(tmpdir(), `dcm-api-contract-${managementApiOwner}-`))
          roots.push(root)

          const dashboardDir = join(root, 'dist')
          mkdirSync(join(dashboardDir, 'assets'), { recursive: true })
          writeFileSync(
            join(dashboardDir, 'index.html'),
            '<!doctype html><title>CONTRACT_DASHBOARD</title>',
          )
          writeFileSync(
            join(dashboardDir, 'assets', 'style.css'),
            'body { background: #121212; }',
          )

          process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.ApiContract.${managementApiOwner}.${process.pid}`

          const runtime: ManagerRuntime = await startManager({
            databasePath: join(root, 'manager.db'),
            runtimeRoot: join(root, 'workers'),
            dashboardDir,
            mcpPort: 0,
            managementPort: 0,
            platformOwner: 'rust',
            workerOwner: 'rust',
            stateOwner: 'rust',
            managementApiOwner,
            nativeSidecarPath: exePath,
          })

          try {
            // 1. GET /api/health
            const healthRes = await fetch(`${runtime.managementUrl}/api/health`)
            expect(healthRes.status).toBe(200)
            const healthJson = normalizeContractValue(await healthRes.json())
            expect(healthJson).toEqual({
              status: 'ok',
              startedAt: '[TIMESTAMP]',
              uptimeMs: '[UPTIME_MS]',
            })

            // 2. GET /api/connection
            const connRes = await fetch(`${runtime.managementUrl}/api/connection`)
            expect(connRes.status).toBe(200)
            const connJson = normalizeContractValue(await connRes.json())
            expect(connJson).toEqual({
              mode: 'direct-local',
              mcpUrl: 'http://127.0.0.1:[PORT]/mcp',
              workerStrategy: 'sticky-failover',
            })

            // 3. GET /api/workers
            const workersRes = await fetch(`${runtime.managementUrl}/api/workers`)
            expect(workersRes.status).toBe(200)
            const workersJson = normalizeContractValue(await workersRes.json()) as any[]
            expect(workersJson).toHaveLength(2)
            for (const w of workersJson) {
              expect(w.status).toBe('READY')
              expect(w.enabled).toBe(true)
              expect(w.activeSessionCount).toBe(0)
              expect(w.pid).toBe('[PID]')
              expect(w.createdAt).toBe('[TIMESTAMP]')
              expect(w.updatedAt).toBe('[TIMESTAMP]')
            }

            // 4. GET /api/sessions
            const sessionsRes = await fetch(`${runtime.managementUrl}/api/sessions`)
            expect(sessionsRes.status).toBe(200)
            const sessionsJson = await sessionsRes.json()
            expect(sessionsJson).toEqual([])

            // 5. GET /api/events
            const eventsRes = await fetch(`${runtime.managementUrl}/api/events`)
            expect(eventsRes.status).toBe(200)
            const eventsJson = await eventsRes.json() as any[]
            expect(eventsJson.length).toBeGreaterThan(0)
            for (const ev of eventsJson) {
              expect(ev.type).not.toBe('TOOL_CALL')
              expect(ev.createdAt).toBeTruthy()
            }

            // 6. Tool-calls: Append valid event and malformed event
            await runtime.state.appendEvent({
              sessionId: 'session-contract-1',
              workerId: 'worker-1',
              type: 'TOOL_CALL',
              message: 'read_file OK',
              metadataJson: JSON.stringify({
                toolName: 'read_file',
                status: 'OK',
                durationMs: 35,
                argsSummary: 'package.json',
                failedOver: false,
                error: null,
              }),
              createdAt: new Date().toISOString(),
            })

            await runtime.state.appendEvent({
              sessionId: 'session-contract-1',
              workerId: 'worker-1',
              type: 'TOOL_CALL',
              message: 'malformed_tool degraded',
              metadataJson: '{ broken json syntax ',
              createdAt: new Date().toISOString(),
            })

            const toolCallsRes = await fetch(`${runtime.managementUrl}/api/tool-calls`)
            expect(toolCallsRes.status).toBe(200)
            const toolCallsJson = normalizeContractValue(await toolCallsRes.json()) as any[]
            expect(toolCallsJson.length).toBeGreaterThanOrEqual(2)

            const validToolCall = toolCallsJson.find((t) => t.toolName === 'read_file')
            expect(validToolCall).toMatchObject({
              toolName: 'read_file',
              status: 'OK',
              durationMs: 35,
              argsSummary: 'package.json',
              failedOver: false,
              error: null,
            })

            const corruptToolCall = toolCallsJson.find((t) => t.toolName === 'malformed_tool')
            expect(corruptToolCall).toMatchObject({
              toolName: 'malformed_tool',
              status: 'OK',
              durationMs: 0,
              argsSummary: '',
              failedOver: false,
              error: null,
            })

            // 7. Worker Mutations
            // Restart
            const restartRes = await fetch(`${runtime.managementUrl}/api/workers/worker-1/restart`, {
              method: 'POST',
            })
            expect(restartRes.status).toBe(200)
            const restartJson = await restartRes.json() as any
            expect(restartJson.id).toBe('worker-1')
            expect(restartJson.status).toBe('READY')

            // Disable
            const disableRes = await fetch(`${runtime.managementUrl}/api/workers/worker-1/disable`, {
              method: 'POST',
            })
            expect(disableRes.status).toBe(200)
            const disableJson = await disableRes.json() as any
            expect(disableJson.id).toBe('worker-1')
            expect(disableJson.enabled).toBe(false)

            // Enable
            const enableRes = await fetch(`${runtime.managementUrl}/api/workers/worker-1/enable`, {
              method: 'POST',
            })
            expect(enableRes.status).toBe(200)
            const enableJson = await enableRes.json() as any
            expect(enableJson.id).toBe('worker-1')
            expect(enableJson.enabled).toBe(true)

            // Unknown worker action -> 404
            const notFoundRes = await fetch(
              `${runtime.managementUrl}/api/workers/nonexistent-worker/restart`,
              { method: 'POST' },
            )
            expect(notFoundRes.status).toBe(404)
            const notFoundJson = await notFoundRes.json() as any
            expect(notFoundJson).toMatchObject({
              error: 'WORKER_NOT_FOUND',
              workerId: 'nonexistent-worker',
            })

            // 8. GET /api/resources
            const resRes = await fetch(`${runtime.managementUrl}/api/resources`)
            expect(resRes.status).toBe(200)
            const resJson = await resRes.json() as any
            expect(resJson).toHaveProperty('available')
            expect(resJson).toHaveProperty('sampledAt')
            expect(resJson).toHaveProperty('total')
            expect(resJson).toHaveProperty('system')
            expect(Array.isArray(resJson.items)).toBe(true)

            const itemIds = resJson.items.map((i: any) => i.id)
            expect(itemIds).toContain('manager')
            expect(itemIds).toContain('tunnel')
            expect(itemIds).toContain('worker-1')
            expect(itemIds).toContain('worker-2')

            // 9. Static assets & Traversal rejection
            const rootStatic = await fetch(`${runtime.managementUrl}/`)
            expect(rootStatic.status).toBe(200)
            expect(await rootStatic.text()).toContain('CONTRACT_DASHBOARD')

            const assetStatic = await fetch(`${runtime.managementUrl}/assets/style.css`)
            expect(assetStatic.status).toBe(200)
            expect(await assetStatic.text()).toContain('#121212')

            // Directory traversal rejection
            const traversalRes = await fetch(`${runtime.managementUrl}/..%2F..%2Fpackage.json`)
            expect([400, 404]).toContain(traversalRes.status)
          } finally {
            await runtime.close()
          }
        },
        20000,
      )
    })
  }
})
