import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { DesktopCommanderProcessFactory, WorkerProcessHandle } from '@dc-manager/worker-manager'
import { startManager, type ManagerRuntime } from '../../apps/server/src/main'

const roots: string[] = []
const fakeScript = resolve('tests/fakes/fake-mcp-worker.ts')

class FakeProcessFactory implements DesktopCommanderProcessFactory {
  readonly startCounts = new Map<string, number>()
  readonly children = new Map<string, ChildProcessWithoutNullStreams>()
  readonly failNextStart = new Set<string>()

  constructor(private readonly mutationFile: string) {}

  async start(workerId: string): Promise<WorkerProcessHandle> {
    this.startCounts.set(workerId, (this.startCounts.get(workerId) ?? 0) + 1)
    if (this.failNextStart.delete(workerId)) throw new Error(`configured restart failure: ${workerId}`)
    const child = spawn(process.execPath, ['--import', 'tsx', fakeScript], {
      env: { ...process.env, FAKE_WORKER_ID: workerId, FAKE_MUTATION_FILE: this.mutationFile },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    if (!child.pid) throw new Error(`fake worker did not start: ${workerId}`)
    this.children.set(workerId, child)
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
    return {
      pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill()
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2000))])
      },
    }
  }

  crash(workerId: string): void {
    const child = this.children.get(workerId)
    if (!child || child.exitCode !== null) throw new Error(`worker is not running: ${workerId}`)
    child.kill()
  }
}

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'integration-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function identify(client: Client, sessionId: string): Promise<string> {
  const result = await client.callTool({ name: 'identify', arguments: {}, _meta: { 'openai/session': sessionId } as never })
  const item = result.content[0]
  if (!item || item.type !== 'text') throw new Error('identify did not return text')
  return item.text
}

async function waitForStatus(runtime: ManagerRuntime, workerId: string, status: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (runtime.database.workers.getWorker(workerId)?.status === status) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`Timed out waiting for ${workerId} -> ${status}; got ${runtime.database.workers.getWorker(workerId)?.status}`)
}

async function start(root: string, factory: FakeProcessFactory): Promise<ManagerRuntime> {
  return startManager({ databasePath: join(root, 'manager.db'), runtimeRoot: join(root, 'workers'), mcpPort: 0, managementPort: 0, dashboardDir: join(root, 'no-dashboard') }, { processFactory: factory })
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('router integration', () => {
  it('balances new sessions, keeps them sticky, and preserves binding across manager restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-integration-')); roots.push(root); const mutationFile = join(root, 'mutations.log')
    let runtime = await start(root, new FakeProcessFactory(mutationFile)); let clientA = await connect(runtime.mcpUrl); let clientB = await connect(runtime.mcpUrl)
    const firstA = await identify(clientA, 'chat-a'); const secondA = await identify(clientA, 'chat-a'); const firstB = await identify(clientB, 'chat-b')
    expect(secondA).toBe(firstA); expect(new Set([firstA, firstB])).toEqual(new Set(['worker-1', 'worker-2']))
    await clientA.close(); await clientB.close(); await runtime.close()

    runtime = await start(root, new FakeProcessFactory(mutationFile)); clientA = await connect(runtime.mcpUrl)
    expect(await identify(clientA, 'chat-a')).toBe(firstA)
    await clientA.close(); await runtime.close()
  })

  it('recovers a crashed worker with a new MCP handshake and keeps the session binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-recovery-')); roots.push(root); const factory = new FakeProcessFactory(join(root, 'mutations.log'))
    const runtime = await start(root, factory); const client = await connect(runtime.mcpUrl)
    try {
      const original = await identify(client, 'chat-recover')
      factory.crash(original); await waitForStatus(runtime, original, 'DEGRADED')
      expect(await identify(client, 'chat-recover')).toBe(original)
      expect(factory.startCounts.get(original)).toBe(2)
      expect(runtime.database.sessions.getSession('chat-recover')?.workerId).toBe(original)
      expect(runtime.database.events.listEvents().filter((event) => event.type === 'SESSION_FAILOVER' && event.sessionId === 'chat-recover')).toHaveLength(0)
    } finally { await client.close(); await runtime.close() }
  })

  it('rebinds only after recovery fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-failover-')); roots.push(root); const factory = new FakeProcessFactory(join(root, 'mutations.log'))
    const runtime = await start(root, factory); const client = await connect(runtime.mcpUrl)
    try {
      const original = await identify(client, 'chat-failover'); factory.crash(original); await waitForStatus(runtime, original, 'DEGRADED'); factory.failNextStart.add(original)
      const replacement = await identify(client, 'chat-failover')
      expect(replacement).not.toBe(original); expect(factory.startCounts.get(original)).toBe(2); expect(runtime.database.sessions.getSession('chat-failover')?.workerId).toBe(replacement)
      expect(runtime.database.events.listEvents().some((event) => event.type === 'SESSION_FAILOVER' && event.sessionId === 'chat-failover')).toBe(true)
    } finally { await client.close(); await runtime.close() }
  })

  it('does not replay an ambiguous mutating call after the worker already executed it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-ambiguous-')); roots.push(root); const mutationFile = join(root, 'mutations.log'); const factory = new FakeProcessFactory(mutationFile)
    const runtime = await start(root, factory); const client = await connect(runtime.mcpUrl)
    try {
      const original = await identify(client, 'chat-mutate')
      await expect(client.callTool({ name: 'ambiguous_mutation', arguments: {}, _meta: { 'openai/session': 'chat-mutate' } as never })).rejects.toThrow()
      await waitForStatus(runtime, original, 'DEGRADED')
      expect(existsSync(mutationFile)).toBe(true); expect(readFileSync(mutationFile, 'utf8').trim().split(/\r?\n/)).toEqual([original])
      expect(runtime.database.sessions.getSession('chat-mutate')?.workerId).toBe(original)
      expect(runtime.database.events.listEvents().filter((event) => event.type === 'SESSION_FAILOVER' && event.sessionId === 'chat-mutate')).toHaveLength(0)
    } finally { await client.close(); await runtime.close() }
  })
})

