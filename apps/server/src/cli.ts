import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { startManager } from './main.js'
import type { ManagerConfig } from './config.js'

export function createDefaultManagerConfig(root = process.cwd()): ManagerConfig {
  const repoRoot = resolve(root)
  return {
    databasePath: join(repoRoot, 'data', 'manager.db'),
    runtimeRoot: join(repoRoot, 'data', 'workers'),
    dashboardDir: join(repoRoot, 'apps', 'dashboard', 'dist'),
    mcpPort: 8787,
    managementPort: 8788,
  }
}

export async function runManagerCli(): Promise<void> {
  const runtime = await startManager(createDefaultManagerConfig())
  console.log(`Desktop Commander Manager MCP: ${runtime.mcpUrl}`)
  console.log(`Desktop Commander Manager UI:  ${runtime.managementUrl}`)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await runtime.close()
  }
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  runManagerCli().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
