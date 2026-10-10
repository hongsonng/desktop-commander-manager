import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { startManager } from './main.js'
import type { CapabilityOwner, ManagerConfig, StateOwner } from './config.js'

export {
  WINDOWS_AUTOSTART_TASK_NAME,
  WINDOWS_TUNNEL_TASK_NAME,
  TUNNEL_PROFILE_NAME,
  getDefaultTunnelProfilePath,
  createWindowsAutostartDeleteSpec,
  createWindowsAutostartRunSpec,
  createWindowsAutostartTaskSpec,
  createWindowsTunnelAutostartTaskSpec,
  createWindowsRunKeyDeleteSpec,
  createWindowsRunKeyQuerySpec,
  createWindowsRunKeySetSpec,
} from './windows-autostart.js'

export function parseCapabilityOwner(
  value: string | undefined,
  defaultValue: CapabilityOwner = 'rust',
  varName = 'DCM_PLATFORM_OWNER',
): CapabilityOwner {
  if (!value) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === 'node' || normalized === 'rust' || normalized === 'shadow') {
    return normalized
  }
  throw new Error(`Invalid ${varName} "${value}". Valid options are: node, rust, shadow.`)
}

export function parseStateOwner(
  value: string | undefined,
  defaultValue: StateOwner = 'node',
  varName = 'DCM_STATE_OWNER',
): StateOwner {
  if (!value) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === 'node' || normalized === 'rust') {
    return normalized
  }
  throw new Error(`Invalid ${varName} "${value}". Valid options are: node, rust.`)
}

export function validateManagerConfig(config: ManagerConfig): void {
  if (config.stateOwner === 'rust' && config.workerOwner !== 'rust') {
    throw new Error('stateOwner="rust" requires workerOwner="rust"')
  }
  if (
    (config.stateOwner === 'rust' || config.workerOwner === 'rust') &&
    config.nativeSidecarPath &&
    !existsSync(config.nativeSidecarPath)
  ) {
    throw new Error(`Native sidecar executable not found at "${config.nativeSidecarPath}"`)
  }
}

export function createDefaultManagerConfig(root = process.cwd(), env = process.env): ManagerConfig {
  const repoRoot = resolve(root)
  const platformOwner = parseCapabilityOwner(env.DCM_PLATFORM_OWNER, 'rust', 'DCM_PLATFORM_OWNER')
  const workerOwner = parseCapabilityOwner(env.DCM_WORKER_OWNER, 'node', 'DCM_WORKER_OWNER')
  const stateOwner = parseStateOwner(env.DCM_STATE_OWNER, 'node', 'DCM_STATE_OWNER')
  const nativeSidecarPath = env.DCM_NATIVE_SIDECAR_PATH ?? join(repoRoot, 'target', 'release', 'dcm-manager.exe')

  return {
    databasePath: join(repoRoot, 'data', 'manager.db'),
    runtimeRoot: join(repoRoot, 'data', 'workers'),
    dashboardDir: join(repoRoot, 'apps', 'dashboard', 'dist'),
    mcpPort: 8787,
    managementPort: 8788,
    platformOwner,
    workerOwner,
    stateOwner,
    nativeSidecarPath,
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
