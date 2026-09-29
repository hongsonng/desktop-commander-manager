import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'

export interface WorkerExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface WorkerProcessHandle {
  pid: number
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exited: Promise<WorkerExit>
  stop(): Promise<void>
}

export interface DesktopCommanderProcessFactory {
  start(workerId: string, runtimeDir: string): Promise<WorkerProcessHandle>
}

export function buildWorkerEnvironment(runtimeDir: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const root = resolve(runtimeDir)
  const home = resolve(join(root, 'home'))
  const temp = resolve(join(root, 'temp'))
  return { ...baseEnv, USERPROFILE: home, HOME: home, TEMP: temp, TMP: temp }
}

export function createDesktopCommanderProcessFactory(): DesktopCommanderProcessFactory {
  return {
    async start(_workerId, runtimeDir) {
      const root = resolve(runtimeDir)
      const logs = join(root, 'logs')
      mkdirSync(join(root, 'home'), { recursive: true })
      mkdirSync(join(root, 'temp'), { recursive: true })
      mkdirSync(logs, { recursive: true })

      const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
      const child = spawn(command, ['-y', '@wonderwhy-er/desktop-commander@latest', '--no-onboarding'], {
        env: buildWorkerEnvironment(root),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (!child.pid || !child.stdin || !child.stdout || !child.stderr) throw new Error('Failed to start Desktop Commander worker')

      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdoutLog = join(logs, 'stdout.log')
      const stderrLog = join(logs, 'stderr.log')
      child.stdout.on('data', (chunk) => { appendFileSync(stdoutLog, chunk); stdout.write(chunk) })
      child.stdout.on('end', () => stdout.end())
      child.stderr.on('data', (chunk) => { appendFileSync(stderrLog, chunk); stderr.write(chunk) })
      child.stderr.on('end', () => stderr.end())

      const exited = new Promise<WorkerExit>((resolveExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
        child.once('error', () => resolveExit({ code: 1, signal: null }))
      })

      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout,
        stderr,
        exited,
        async stop() {
          if (child.exitCode !== null) return
          child.kill()
          await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))])
          if (child.exitCode === null) child.kill('SIGKILL')
        },
      }
    },
  }
}
