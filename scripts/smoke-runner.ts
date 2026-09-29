import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startManager } from '../apps/server/src/main.js'

const repoRoot = resolve(process.cwd())
const smokeRoot = join(repoRoot, '.superpowers', 'smoke')
const sessionId = `smoke-${Date.now()}`
let runtime: Awaited<ReturnType<typeof startManager>> | undefined
let client: Client | undefined

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`Manager health check did not become ready: ${url}`)
}

try {
  rmSync(smokeRoot, { recursive: true, force: true })
  runtime = await startManager({
    databasePath: join(smokeRoot, 'manager.db'),
    runtimeRoot: join(smokeRoot, 'workers'),
    dashboardDir: join(repoRoot, 'apps', 'dashboard', 'dist'),
    mcpPort: 0,
    managementPort: 0,
  })
  await waitForHealth(runtime.managementUrl)

  const workers = runtime.database.workers.listWorkers()
  if (workers.length !== 2 || workers.some((worker) => worker.status !== 'READY')) {
    throw new Error(`Expected two READY workers, got ${JSON.stringify(workers.map(({ id, status }) => ({ id, status })))}`)
  }
  for (const worker of workers) {
    const home = join(smokeRoot, 'workers', worker.id, 'home')
    const temp = join(smokeRoot, 'workers', worker.id, 'temp')
    if (!existsSync(home) || !existsSync(temp)) throw new Error(`Missing isolated runtime directories for ${worker.id}`)
  }

  const transport = new StreamableHTTPClientTransport(new URL(runtime.mcpUrl))
  client = new Client({ name: 'desktop-commander-manager-smoke', version: '1.0.0' })
  await client.connect(transport)
  const meta = { 'openai/session': sessionId } as never
  const tools = await client.listTools({ _meta: meta })
  if (!tools.tools.some((tool) => tool.name === 'get_config')) throw new Error('Desktop Commander get_config tool was not discovered')
  const configResult = await client.callTool({ name: 'get_config', arguments: {}, _meta: meta })
  if (!Array.isArray(configResult.content) || configResult.content.length === 0) throw new Error('get_config returned no content')

  const binding = runtime.database.sessions.getSession(sessionId)
  if (!binding) throw new Error('Smoke session was not persisted')
  console.log(`SMOKE PASS: ${sessionId} -> ${binding.workerId}; workers=${workers.map((worker) => `${worker.id}:${worker.status}`).join(',')}`)
} finally {
  await client?.close().catch(() => undefined)
  await runtime?.close().catch(() => undefined)
  rmSync(smokeRoot, { recursive: true, force: true })
}
