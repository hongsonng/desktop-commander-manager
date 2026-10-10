import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { UpstreamCallError } from '@dc-manager/router'
import type { ProxyWorkerClient, WorkerToolResult, WorkerToolsResult } from '@dc-manager/mcp-proxy'
import type { EventRecord, RouteContext, SessionBinding, WorkerDescriptor, WorkerRecord } from '@dc-manager/shared'
import type { EventInput } from './manager-state.js'
import type { ProxyCallToolResult, ProxyListToolsResult } from './mcp-proxy-backend.js'

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

export interface WorkerStartRequest {
  workerId: string
  runtimeDir: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface WorkerStopRequest {
  workerId: string
}

export interface WorkerRestartRequest {
  workerId: string
}

export interface WorkerListToolsRequest {
  workerId: string
  meta?: Record<string, unknown>
}

export interface WorkerCallToolRequest {
  workerId: string
  name: string
  arguments: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface WorkerHandleResult {
  workerId: string
  pid: number
}

export interface WorkerListToolsResult {
  tools: Array<Record<string, unknown>>
}

export interface WorkerCallToolResult {
  content: Array<Record<string, unknown>>
  isError?: boolean
}

export interface WorkerStateEvent {
  workerId: string
  state: string
  pid?: number
  reason?: string
  exitCode?: number
  signal?: string
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
  private workerStateListeners = new Set<(event: WorkerStateEvent) => void>()

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

  static async start(
    executablePath: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<NativeSidecarClient> {
    const child = spawn(executablePath, ['sidecar'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        NODE_EXE: process.execPath,
        ...env,
      },
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

  onWorkerStateChanged(handler: (event: WorkerStateEvent) => void): () => void {
    this.workerStateListeners.add(handler)
    return () => {
      this.workerStateListeners.delete(handler)
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      // Protocol desynchronization or corrupted stdout
      return
    }

    if (msg.event && msg.params) {
      if (msg.event === 'worker/stateChanged') {
        for (const listener of this.workerStateListeners) {
          try {
            listener(msg.params)
          } catch {
            // Ignore listener exceptions
          }
        }
      }
      return
    }

    const id = typeof msg.id === 'number' ? msg.id : null
    if (id === null) return

    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)

    if (msg.error) {
      const failureKind = msg.error.failureKind ?? 'UPSTREAM_ERROR'
      const err = new UpstreamCallError(
        failureKind,
        msg.error.message || `Sidecar error [${msg.error.code}]`,
      )
      ;(err as unknown as { code?: string }).code = msg.error.code
      pending.reject(err)
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

  async workerStart(request: WorkerStartRequest): Promise<WorkerHandleResult> {
    return this.request<WorkerHandleResult>('worker/start', request)
  }

  async workerStop(request: WorkerStopRequest): Promise<WorkerHandleResult> {
    return this.request<WorkerHandleResult>('worker/stop', request)
  }

  async workerRestart(request: WorkerRestartRequest): Promise<WorkerHandleResult> {
    return this.request<WorkerHandleResult>('worker/restart', request)
  }

  async workerListTools(request: WorkerListToolsRequest): Promise<WorkerListToolsResult> {
    return this.request<WorkerListToolsResult>('worker/listTools', request)
  }

  async workerCallTool(request: WorkerCallToolRequest): Promise<WorkerCallToolResult> {
    return this.request<WorkerCallToolResult>('worker/callTool', request)
  }

  async workerShutdownAll(): Promise<void> {
    return this.request<void>('worker/shutdownAll', {})
  }

  async backendOpen(databasePath: string, runtimeRoot: string): Promise<void> {
    await this.request<void>('backend/open', { databasePath, runtimeRoot })
  }

  async backendClose(): Promise<void> {
    await this.request<void>('backend/close', {})
  }

  async proxyListTools(
    context: RouteContext,
    meta?: Record<string, unknown>,
  ): Promise<ProxyListToolsResult> {
    return this.request<ProxyListToolsResult>('proxy/listTools', { context, meta })
  }

  async proxyCallTool(
    context: RouteContext,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ProxyCallToolResult> {
    return this.request<ProxyCallToolResult>('proxy/callTool', {
      context,
      name,
      arguments: args,
      meta,
    })
  }

  async stateGetWorker(workerId: string): Promise<WorkerRecord | undefined> {
    const res = await this.request<{ worker: WorkerRecord | null }>('state/getWorker', {
      workerId,
    })
    return res.worker ?? undefined
  }

  async stateListWorkers(): Promise<WorkerDescriptor[]> {
    const res = await this.request<{ workers: WorkerDescriptor[] }>('state/listWorkers', {})
    return res.workers
  }

  async stateListSessions(): Promise<SessionBinding[]> {
    const res = await this.request<{ sessions: SessionBinding[] }>('state/listSessions', {})
    return res.sessions
  }

  async stateListEvents(limit?: number): Promise<EventRecord[]> {
    const res = await this.request<{ events: EventRecord[] }>('state/listEvents', { limit })
    return res.events
  }

  async stateAppendEvent(event: EventInput): Promise<EventRecord> {
    const res = await this.request<{ event: EventRecord }>('state/appendEvent', { event })
    return res.event
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

export class NativeSidecarWorkerClient implements ProxyWorkerClient {
  constructor(
    private readonly sidecar: NativeSidecarClient,
    private readonly workerId: string,
  ) {}

  async listTools(meta?: Record<string, unknown>): Promise<WorkerToolsResult> {
    const res = await this.sidecar.workerListTools({
      workerId: this.workerId,
      meta,
    })
    return { tools: res.tools as any }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<WorkerToolResult> {
    const res = await this.sidecar.workerCallTool({
      workerId: this.workerId,
      name,
      arguments: args,
      meta,
    })
    return {
      content: res.content as any,
      isError: res.isError ?? false,
    }
  }

  async close(): Promise<void> {
    // Lifetime managed by sidecar supervisor
  }
}
