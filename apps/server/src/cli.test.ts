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

  it('builds a minute watchdog task for the optional secure tunnel', () => {
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
        '/Create', '/TN', 'DesktopCommanderTunnel', '/SC', 'MINUTE', '/MO', '1', '/RL', 'LIMITED', '/F',
        '/TR', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(root, 'scripts', 'run-tunnel-headless.ps1')}"`,
      ],
    })
    expect(api.createWindowsAutostartRunSpec!('DesktopCommanderManager')).toEqual({ command, args: ['/Run', '/TN', 'DesktopCommanderManager'] })
    expect(api.createWindowsAutostartDeleteSpec!('DesktopCommanderManager')).toEqual({ command, args: ['/Delete', '/TN', 'DesktopCommanderManager', '/F'] })
  })

  it('resolves the default Secure MCP Tunnel profile from APPDATA', () => {
    const api = cli as unknown as {
      getDefaultTunnelProfilePath?: (env: NodeJS.ProcessEnv) => string
    }
    expect(api.getDefaultTunnelProfilePath).toBeTypeOf('function')
    expect(api.getDefaultTunnelProfilePath!({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' })).toBe(
      join('C:\\Users\\test\\AppData\\Roaming', 'tunnel-client', 'desktop-commander-manager.yaml'),
    )
  })

  it('builds a per-user HKCU Run fallback when Task Scheduler is not permitted', () => {
    const root = resolve('D:/example/dc-manager')
    const api = cli as unknown as {
      createWindowsRunKeySetSpec?: (valueName: string, runner: string) => { command: string; args: string[] }
      createWindowsRunKeyQuerySpec?: (valueName: string) => { command: string; args: string[] }
      createWindowsRunKeyDeleteSpec?: (valueName: string) => { command: string; args: string[] }
    }
    expect(api.createWindowsRunKeySetSpec).toBeTypeOf('function')
    expect(api.createWindowsRunKeyQuerySpec).toBeTypeOf('function')
    expect(api.createWindowsRunKeyDeleteSpec).toBeTypeOf('function')

    const runner = join(root, 'scripts', 'run-manager-headless.ps1')
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
    const bootstrap = join(root, 'scripts', 'launch-autostart-runner.ps1')
    expect(api.createWindowsRunKeySetSpec!('DesktopCommanderManager', runner)).toEqual({
      command: reg,
      args: ['ADD', key, '/V', 'DesktopCommanderManager', '/T', 'REG_SZ', '/D', `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${bootstrap}" -Runner "${runner}"`, '/F'],
    })
    expect(api.createWindowsRunKeyQuerySpec!('DesktopCommanderManager')).toEqual({ command: reg, args: ['QUERY', key, '/V', 'DesktopCommanderManager'] })
    expect(api.createWindowsRunKeyDeleteSpec!('DesktopCommanderManager')).toEqual({ command: reg, args: ['DELETE', key, '/V', 'DesktopCommanderManager', '/F'] })
  })
})
