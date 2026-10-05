import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import * as cli from './cli'

describe('CLI defaults', () => {
  it('keeps database, worker runtime, and dashboard paths inside the repository', () => {
    const root = resolve('D:/example/dc-manager')
    expect(cli.createDefaultManagerConfig(root)).toEqual({
      databasePath: join(root, 'data', 'manager.db'),
      runtimeRoot: join(root, 'data', 'workers'),
      dashboardDir: join(root, 'apps', 'dashboard', 'dist'),
      mcpPort: 8787,
      managementPort: 8788,
    })
  })

  it('builds a Windows logon task that runs the manager headlessly from this repository', () => {
    const root = resolve('D:/example/dc-manager')
    const createSpec = (cli as unknown as { createWindowsAutostartTaskSpec?: (repoRoot: string) => { command: string; args: string[] } }).createWindowsAutostartTaskSpec
    expect(createSpec).toBeTypeOf('function')
    expect(createSpec!(root)).toEqual({
      command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe'),
      args: [
        '/Create', '/TN', 'DesktopCommanderManager', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
        '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(root, 'scripts', 'run-manager-headless.ps1')}"`,
      ],
    })
  })

  it('builds install, run, and delete specs for the optional secure tunnel task', () => {
    const root = resolve('D:/example/dc-manager')
    const api = cli as unknown as {
      createWindowsTunnelAutostartTaskSpec?: (repoRoot: string) => { command: string; args: string[] }
      createWindowsAutostartRunSpec?: (taskName: string) => { command: string; args: string[] }
      createWindowsAutostartDeleteSpec?: (taskName: string) => { command: string; args: string[] }
    }
    expect(api.createWindowsTunnelAutostartTaskSpec).toBeTypeOf('function')
    expect(api.createWindowsAutostartRunSpec).toBeTypeOf('function')
    expect(api.createWindowsAutostartDeleteSpec).toBeTypeOf('function')
    const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'schtasks.exe')
    expect(api.createWindowsTunnelAutostartTaskSpec!(root)).toEqual({
      command,
      args: [
        '/Create', '/TN', 'DesktopCommanderTunnel', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
        '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(root, 'scripts', 'run-tunnel-headless.ps1')}"`,
      ],
    })
    expect(api.createWindowsAutostartRunSpec!('DesktopCommanderManager')).toEqual({ command, args: ['/Run', '/TN', 'DesktopCommanderManager'] })
    expect(api.createWindowsAutostartDeleteSpec!('DesktopCommanderManager')).toEqual({ command, args: ['/Delete', '/TN', 'DesktopCommanderManager', '/F'] })
  })
})
