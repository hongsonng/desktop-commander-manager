import { join, resolve } from 'node:path'

export const WINDOWS_AUTOSTART_TASK_NAME = 'DesktopCommanderManager'
export const WINDOWS_TUNNEL_TASK_NAME = 'DesktopCommanderTunnel'
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

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
  return createWindowsLogonTaskSpec(WINDOWS_TUNNEL_TASK_NAME, join(repoRoot, 'scripts', 'run-tunnel-headless.ps1'), env)
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
  const commandLine = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}"`
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
