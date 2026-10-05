import { execFile as execFileCallback, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import {
  WINDOWS_AUTOSTART_TASK_NAME,
  WINDOWS_TUNNEL_TASK_NAME,
  createWindowsAutostartDeleteSpec,
  createWindowsAutostartRunSpec,
  createWindowsAutostartTaskSpec,
  createWindowsTunnelAutostartTaskSpec,
  createWindowsRunKeyDeleteSpec,
  createWindowsRunKeyQuerySpec,
  createWindowsRunKeySetSpec,
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

export type AutostartMechanism = 'task' | 'run-key' | false

function taskQuerySpec(taskName: string): CommandSpec {
  return {
    command: `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\schtasks.exe`,
    args: ['/Query', '/TN', taskName],
  }
}

function launchRunner(runner: string): void {
  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', runner], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

async function installEntry(taskName: string, runner: string, taskSpec: CommandSpec): Promise<Exclude<AutostartMechanism, false>> {
  const taskInstalled = await runSpec(taskSpec, true)
  if (taskInstalled) {
    await runSpec(createWindowsRunKeyDeleteSpec(taskName), true)
    await runSpec(createWindowsAutostartRunSpec(taskName))
    return 'task'
  }

  await runSpec(createWindowsRunKeySetSpec(taskName, runner))
  launchRunner(runner)
  return 'run-key'
}

async function entryStatus(taskName: string): Promise<AutostartMechanism> {
  if (await runSpec(taskQuerySpec(taskName), true)) return 'task'
  if (await runSpec(createWindowsRunKeyQuerySpec(taskName), true)) return 'run-key'
  return false
}

export async function installAutostart(root = process.cwd()): Promise<{ manager: Exclude<AutostartMechanism, false>; tunnel: AutostartMechanism }> {
  if (process.platform !== 'win32') throw new Error('Windows autostart is only supported on Windows')
  const repoRoot = resolve(root)
  const managerRunner = join(repoRoot, 'scripts', 'run-manager-headless.ps1')
  const manager = await installEntry(WINDOWS_AUTOSTART_TASK_NAME, managerRunner, createWindowsAutostartTaskSpec(repoRoot))

  const tunnelAvailable = await commandExists('tunnel-client')
  let tunnel: AutostartMechanism = false
  if (tunnelAvailable) {
    const tunnelRunner = join(repoRoot, 'scripts', 'run-tunnel-headless.ps1')
    tunnel = await installEntry(WINDOWS_TUNNEL_TASK_NAME, tunnelRunner, createWindowsTunnelAutostartTaskSpec(repoRoot))
  } else {
    await runSpec(createWindowsAutostartDeleteSpec(WINDOWS_TUNNEL_TASK_NAME), true)
    await runSpec(createWindowsRunKeyDeleteSpec(WINDOWS_TUNNEL_TASK_NAME), true)
  }

  return { manager, tunnel }
}

export async function uninstallAutostart(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows autostart is only supported on Windows')
  await runSpec(createWindowsAutostartDeleteSpec(WINDOWS_TUNNEL_TASK_NAME), true)
  await runSpec(createWindowsAutostartDeleteSpec(WINDOWS_AUTOSTART_TASK_NAME), true)
  await runSpec(createWindowsRunKeyDeleteSpec(WINDOWS_TUNNEL_TASK_NAME), true)
  await runSpec(createWindowsRunKeyDeleteSpec(WINDOWS_AUTOSTART_TASK_NAME), true)
}

export async function autostartStatus(): Promise<{ manager: AutostartMechanism; tunnel: AutostartMechanism }> {
  if (process.platform !== 'win32') return { manager: false, tunnel: false }
  return {
    manager: await entryStatus(WINDOWS_AUTOSTART_TASK_NAME),
    tunnel: await entryStatus(WINDOWS_TUNNEL_TASK_NAME),
  }
}

function describeMechanism(mechanism: AutostartMechanism): string {
  if (mechanism === 'task') return 'Task Scheduler'
  if (mechanism === 'run-key') return 'HKCU Run'
  return 'not installed'
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? 'status'
  if (action === 'install') {
    const result = await installAutostart()
    console.log(`Manager autostart: installed via ${describeMechanism(result.manager)}`)
    console.log(`Secure MCP Tunnel autostart: ${result.tunnel ? `installed via ${describeMechanism(result.tunnel)}` : 'skipped (tunnel-client not found)'}`)
    return
  }
  if (action === 'uninstall') {
    await uninstallAutostart()
    console.log('Desktop Commander Manager autostart entries removed')
    return
  }
  if (action === 'status') {
    const status = await autostartStatus()
    console.log(`Manager autostart: ${describeMechanism(status.manager)}`)
    console.log(`Tunnel autostart: ${describeMechanism(status.tunnel)}`)
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
