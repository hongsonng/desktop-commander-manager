import { execFile as execFileCallback } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import {
  WINDOWS_AUTOSTART_TASK_NAME,
  WINDOWS_TUNNEL_TASK_NAME,
  createWindowsAutostartDeleteSpec,
  createWindowsAutostartRunSpec,
  createWindowsAutostartTaskSpec,
  createWindowsTunnelAutostartTaskSpec,
} from './windows-autostart.js'

const execFile = promisify(execFileCallback)

type CommandSpec = { command: string; args: string[] }

async function runSpec(spec: CommandSpec, ignoreFailure = false): Promise<boolean> {
  try {
    await execFile(spec.command, spec.args, { windowsHide: true })
    return true
  } catch (error) {
    if (ignoreFailure) return false
    throw error
  }
}

async function commandExists(command: string): Promise<boolean> {
  const where = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\where.exe`
  try {
    await execFile(where, [command], { windowsHide: true })
    return true
  } catch {
    return false
  }
}

export async function installAutostart(root = process.cwd()): Promise<{ manager: true; tunnel: boolean }> {
  if (process.platform !== 'win32') throw new Error('Windows autostart is only supported on Windows')
  const repoRoot = resolve(root)
  await runSpec(createWindowsAutostartTaskSpec(repoRoot))

  const tunnelAvailable = await commandExists('tunnel-client')
  if (tunnelAvailable) await runSpec(createWindowsTunnelAutostartTaskSpec(repoRoot))

  await runSpec(createWindowsAutostartRunSpec(WINDOWS_AUTOSTART_TASK_NAME))
  if (tunnelAvailable) await runSpec(createWindowsAutostartRunSpec(WINDOWS_TUNNEL_TASK_NAME))

  return { manager: true, tunnel: tunnelAvailable }
}

export async function uninstallAutostart(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows autostart is only supported on Windows')
  await runSpec(createWindowsAutostartDeleteSpec(WINDOWS_TUNNEL_TASK_NAME), true)
  await runSpec(createWindowsAutostartDeleteSpec(WINDOWS_AUTOSTART_TASK_NAME), true)
}

export async function autostartStatus(): Promise<{ manager: boolean; tunnel: boolean }> {
  if (process.platform !== 'win32') return { manager: false, tunnel: false }
  const query = (taskName: string): CommandSpec => ({
    command: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\schtasks.exe`,
    args: ['/Query', '/TN', taskName],
  })
  return {
    manager: await runSpec(query(WINDOWS_AUTOSTART_TASK_NAME), true),
    tunnel: await runSpec(query(WINDOWS_TUNNEL_TASK_NAME), true),
  }
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status'
  if (action === 'install') {
    const result = await installAutostart()
    console.log(`Manager autostart: installed`)
    console.log(`Secure MCP Tunnel autostart: ${result.tunnel ? 'installed' : 'skipped (tunnel-client not found)'}`)
    return
  }
  if (action === 'uninstall') {
    await uninstallAutostart()
    console.log('Desktop Commander Manager autostart tasks removed')
    return
  }
  if (action === 'status') {
    const status = await autostartStatus()
    console.log(`Manager task: ${status.manager ? 'installed' : 'not installed'}`)
    console.log(`Tunnel task: ${status.tunnel ? 'installed' : 'not installed'}`)
    return
  }
  throw new Error(`Unknown autostart action: ${action}`)
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
