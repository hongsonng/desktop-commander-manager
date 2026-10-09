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

function createWindowsLogonTaskSpec(taskName: string, runner: string, env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  return {
    command: schtasksCommand(env),
    args: [
      '/Create', '/TN', taskName, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
      '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}"`,
    ],
  }
}

export function createWindowsAutostartTaskSpec(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const repoRoot = resolve(root)
  return createWindowsLogonTaskSpec(WINDOWS_AUTOSTART_TASK_NAME, join(repoRoot, 'scripts', 'run-manager-headless.ps1'), env)
}

export function createWindowsTunnelAutostartTaskSpec(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const repoRoot = resolve(root)
  // A minute schedule acts as a watchdog. Task Scheduler's default IgnoreNew
  // policy keeps the long-running runner single-instance while recovering it
  // after an unexpected process termination.
  return {
    command: schtasksCommand(env),
    args: [
      '/Create', '/TN', WINDOWS_TUNNEL_TASK_NAME, '/SC', 'MINUTE', '/MO', '1', '/RL', 'LIMITED', '/F',
      '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(repoRoot, 'scripts', 'run-tunnel-headless.ps1')}"`,
    ],
  }
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
  // Keep the Run-key process short-lived. The bootstrap asks WMI to create the
  // long-running runner outside the shell/installer process tree.
  const bootstrap = join(dirname(runner), 'launch-autostart-runner.ps1')
  const commandLine = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${bootstrap}" -Runner "${runner}"`
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
