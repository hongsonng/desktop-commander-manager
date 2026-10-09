import { dirname, join, resolve } from 'node:path'

export const WINDOWS_AUTOSTART_TASK_NAME = 'DesktopCommanderManager'
export const WINDOWS_TUNNEL_TASK_NAME = 'DesktopCommanderTunnel'
export const TUNNEL_PROFILE_NAME = 'desktop-commander-manager'
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

export function getDefaultTunnelProfilePath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA ?? (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : undefined)
  if (!appData) throw new Error('APPDATA or USERPROFILE is required to resolve the tunnel profile path')
  return join(appData, 'tunnel-client', `${TUNNEL_PROFILE_NAME}.yaml`)
}

function schtasksCommand(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe')
}

function hiddenRunnerCommand(runner: string, env: NodeJS.ProcessEnv = process.env): string {
  const scriptHost = join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
  const launcher = join(dirname(runner), 'run-headless.vbs')
  // wscript is a GUI host: no console/Windows Terminal is allocated at login.
  return `"${scriptHost}" //B //Nologo "${launcher}" "${runner}"`
}

function createWindowsWatchdogTaskSpec(taskName: string, runner: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  // A minute schedule acts as a watchdog. Task Scheduler's default IgnoreNew
  // policy keeps the long-running runner single-instance while recovering it
  // after an unexpected process-tree termination.
  return {
    command: schtasksCommand(env),
    args: [
      '/Create', '/TN', taskName, '/SC', 'MINUTE', '/MO', '1', '/RL', 'LIMITED', '/F',
      '/TR', hiddenRunnerCommand(runner, env),
    ],
  }
}

export function createWindowsAutostartTaskSpec(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const repoRoot = resolve(root)
  return createWindowsWatchdogTaskSpec(WINDOWS_AUTOSTART_TASK_NAME, join(repoRoot, 'scripts', 'run-manager-headless.ps1'), env)
}

export function createWindowsTunnelAutostartTaskSpec(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const repoRoot = resolve(root)
  return createWindowsWatchdogTaskSpec(WINDOWS_TUNNEL_TASK_NAME, join(repoRoot, 'scripts', 'run-tunnel-headless.ps1'), env)
}

export function createWindowsAutostartRunSpec(taskName: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: schtasksCommand(env), args: ['/Run', '/TN', taskName] }
}

export function createWindowsAutostartDeleteSpec(taskName: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: schtasksCommand(env), args: ['/Delete', '/TN', taskName, '/F'] }
}

function regCommand(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
}

export function createWindowsRunKeySetSpec(valueName: string, runner: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  // Use the same console-free launcher if Task Scheduler cannot be used.
  // The script host waits on the runner to avoid orphaned terminals.
  const commandLine = hiddenRunnerCommand(runner, env)
  return {
    command: regCommand(env),
    args: ['ADD', WINDOWS_RUN_KEY, '/V', valueName, '/T', 'REG_SZ', '/D', commandLine, '/F'],
  }
}

export function createWindowsRunKeyQuerySpec(valueName: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: regCommand(env), args: ['QUERY', WINDOWS_RUN_KEY, '/V', valueName] }
}

export function createWindowsRunKeyDeleteSpec(valueName: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return { command: regCommand(env), args: ['DELETE', WINDOWS_RUN_KEY, '/V', valueName, '/F'] }
}
