import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export type CapabilityOwner = 'node' | 'rust' | 'shadow'

export interface ProcessUsage {
  rootPid: number | null
  memoryBytes: number
  cpuSeconds: number
  processCount: number
}

export interface ProcessSnapshotRequest {
  managerPid: number
  workerPids: number[]
  tunnelProfile: string
}

export interface ProcessSnapshotResult {
  manager: ProcessUsage
  tunnel: ProcessUsage
  workers: ProcessUsage[]
  diagnostics: string[]
}

export interface ProcessIdentity {
  pid: number
  creationTime100ns: number
  imagePath: string | null
}

export interface KillProcessTreeRequest {
  pid: number
  expectedCreationTime100ns?: number
}

export interface KillTreeResult {
  rootPid: number
  killedCount: number
}

export interface RawUsage {
  rootPid: number | null
  memoryBytes: number
  cpuSeconds: number
  processCount: number
}

export interface RawSnapshot {
  manager: RawUsage
  tunnel: RawUsage
  workers: RawUsage[]
}

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

export class NativeSidecarClient {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private isClosed = false

  private constructor(child: ChildProcess) {
    this.child = child

    if (!child.stdout || !child.stdin) {
      throw new Error('Child process stdio streams not available')
    }

    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      this.handleLine(line)
    })

    child.on('error', (err) => {
      this.handleExit(err)
    })

    child.on('exit', (code, signal) => {
      const err = new Error(`Native sidecar process exited (code=${code}, signal=${signal})`)
      this.handleExit(err)
    })
  }

  static async start(executablePath: string): Promise<NativeSidecarClient> {
    const child = spawn(executablePath, ['sidecar'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    return new Promise((resolve, reject) => {
      let started = false

      const onError = (err: Error) => {
        if (!started) {
          reject(err)
        }
      }

      child.once('error', onError)

      // Allow a brief tick to verify spawn didn't immediately fail (e.g. ENOENT)
      setImmediate(() => {
        if (child.exitCode !== null) {
          reject(new Error(`Native sidecar exited immediately with code ${child.exitCode}`))
        } else {
          started = true
          child.removeListener('error', onError)
          resolve(new NativeSidecarClient(child))
        }
      })
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch (parseError) {
      // Protocol desynchronization or corrupted stdout
      return
    }

    const id = typeof msg.id === 'number' ? msg.id : null
    if (id === null) return

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)

    if (msg.error) {
      pending.reject(new Error(`Sidecar error [${msg.error.code}]: ${msg.error.message}`))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleExit(err: Error): void {
    this.isClosed = true
    for (const [, req] of this.pending) {
      req.reject(err)
    }
    this.pending.clear()
  }

  private request<T>(method: string, params: any): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new Error('Native sidecar client is closed'))
    }

    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.child.stdin!.write(payload, 'utf8', (err) => {
          if (err) {
            this.pending.delete(id)
            reject(err)
          }
        })
      } catch (writeErr) {
        this.pending.delete(id)
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)))
      }
    })
  }

  async snapshot(request: ProcessSnapshotRequest): Promise<RawSnapshot> {
    const result = await this.request<ProcessSnapshotResult>('process/snapshot', request)
    return {
      manager: result.manager,
      tunnel: result.tunnel,
      workers: result.workers,
    }
  }

  async identity(pid: number): Promise<ProcessIdentity | null> {
    return this.request<ProcessIdentity | null>('process/identity', { pid })
  }

  async killTree(request: KillProcessTreeRequest): Promise<KillTreeResult> {
    return this.request<KillTreeResult>('process/killTree', request)
  }

  async close(): Promise<void> {
    if (this.isClosed) return
    this.isClosed = true

    return new Promise((resolve) => {
      const cleanup = () => {
        resolve()
      }

      this.child.once('exit', cleanup)

      try {
        this.child.stdin?.end()
      } catch {
        // Ignore stdin end error
      }

      // Force kill if process does not exit in 1500ms
      const timer = setTimeout(() => {
        try {
          this.child.kill()
        } catch {
          // Ignore
        }
        cleanup()
      }, 1500)

      this.child.once('exit', () => {
        clearTimeout(timer)
      })
    })
  }
}
