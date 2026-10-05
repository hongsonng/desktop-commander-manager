import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { processTreeKillSpec } from './desktop-commander-process.js'

const REMOTE_ARGS = ['-y', '@wonderwhy-er/desktop-commander@latest', 'remote'] as const

export function remoteAccountSpawnSpec(platform: NodeJS.Platform | string, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot ?? 'C:\\Windows'
    const command = env.ComSpec ?? env.COMSPEC ?? join(systemRoot, 'System32', 'cmd.exe')
    return { command, args: ['/d', '/s', '/c', 'npx', ...REMOTE_ARGS] }
  }
  return { command: 'npx', args: [...REMOTE_ARGS] }
}

export function buildRemoteAccountEnvironment(profileDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = resolve(profileDir)
  const home = resolve(join(root, 'home'))
  const temp = resolve(join(root, 'temp'))
  return { ...baseEnv, USERPROFILE: home, HOME: home, TEMP: temp, TMP: temp }
}

export function remoteAccountCredentialPath(profileDir: string): string {
  return resolve(join(profileDir, 'home', '.desktop-commander-device', 'device.json'))
}

export function isRemoteAccountPaired(profileDir: string): boolean {
  return existsSync(remoteAccountCredentialPath(profileDir))
}

export interface RemoteAccountExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface RemoteAccountProcessHandle {
  pid: number
  exited: Promise<RemoteAccountExit>
  stop(): Promise<void>
}

export interface RemoteAccountProcessFactory {
  start(accountId: string, profileDir: string): Promise<RemoteAccountProcessHandle>
}

async function killProcessTree(pid: number): Promise<boolean> {
  const spec = processTreeKillSpec(process.platform, pid, process.env)
  if (!spec) return false
  await new Promise<void>((resolveKill) => {
    const killer = spawn(spec.command, spec.args, { stdio: 'ignore', windowsHide: true })
    let settled = false
    const done = () => { if (!settled) { settled = true; resolveKill() } }
    killer.once('error', done)
    killer.once('exit', done)
  })
  return true
}

export function createRemoteAccountProcessFactory(): RemoteAccountProcessFactory {
  return {
    async start(accountId, profileDir) {
      const root = resolve(profileDir)
      const logs = join(root, 'logs')
      mkdirSync(join(root, 'home'), { recursive: true })
      mkdirSync(join(root, 'temp'), { recursive: true })
      mkdirSync(logs, { recursive: true })

      const spawnSpec = remoteAccountSpawnSpec(process.platform, process.env)
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        env: buildRemoteAccountEnvironment(root),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (!child.pid || !child.stdout || !child.stderr) throw new Error(`Failed to start Remote Desktop Commander account: ${accountId}`)

      child.stdout.on('data', (chunk) => appendFileSync(join(logs, 'stdout.log'), chunk))
      child.stderr.on('data', (chunk) => appendFileSync(join(logs, 'stderr.log'), chunk))
      const exited = new Promise<RemoteAccountExit>((resolveExit) => {
        let resolved = false
        const done = (exit: RemoteAccountExit) => { if (!resolved) { resolved = true; resolveExit(exit) } }
        child.once('exit', (code, signal) => done({ code, signal }))
        child.once('error', () => done({ code: 1, signal: null }))
      })

      return {
        pid: child.pid,
        exited,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return
          const killedTree = await killProcessTree(child.pid!)
          if (!killedTree) child.kill()
          await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))])
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        },
      }
    },
  }
}
