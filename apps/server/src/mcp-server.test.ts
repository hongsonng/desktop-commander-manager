import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { RetryPolicy, UpstreamCallError } from '@dc-manager/router'
import type { RouteContext, WorkerDescriptor } from '@dc-manager/shared'
import { createMcpHttpServer } from './mcp-server'

function descriptor(id: string): WorkerDescriptor {
  return { id, name: id, enabled: true, status: 'READY', pid: 1, failureCount: 0, lastHeartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), activeSessionCount: 0 }
}

class FakeRouter {
  contexts: RouteContext[] = []; failoverCalls: Array<[string, string]> = []; failResolve = false
  async resolve(context: RouteContext) { this.contexts.push(context); if (this.failResolve) throw Object.assign(new Error('No healthy Desktop Commander worker is available'), { code: 'NO_HEALTHY_WORKER' }); return descriptor('worker-1') }
  async failover(sessionId: string, workerId: string) { this.failoverCalls.push([sessionId, workerId]); return descriptor('worker-2') }
}

function fakeClient(options: { fail?: 'PRE_DISPATCH' | 'ACK_UNKNOWN'; text?: string; withUiMeta?: boolean } = {}) {
  let calls = 0
  return {
    async listTools() { return { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { title: 'Echo tool', readOnlyHint: true }, ...(options.withUiMeta ? { _meta: { 'ui/resourceUri': 'ui://desktop-commander/echo', 'openai/outputTemplate': 'ui://desktop-commander/echo', 'openai/widgetAccessible': true, ui: { resourceUri: 'ui://desktop-commander/echo' } } } : {}) }] } },
    async callTool(_name: string, args: Record<string, unknown>) { calls++; if (options.fail) throw new UpstreamCallError(options.fail, 'boom'); return { content: [{ type: 'text', text: options.text ?? String(args.text) }] } },
    async close() {}, get calls() { return calls },
  }
}

async function connect(runtime: Awaited<ReturnType<typeof createMcpHttpServer>>) {
  const transport = new StreamableHTTPClientTransport(new URL(runtime.url))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

describe('MCP HTTP proxy', () => {
  it('supports stateless MCP 2026-07-28 discovery, tool listing, and tool calls', async () => {
    const router = new FakeRouter(); const worker1 = fakeClient({ withUiMeta: true }); const audits: Array<Record<string, unknown>> = []
    const runtime = await createMcpHttpServer({ host: '127.0.0.1', port: 0, sessionRouter: router, retryPolicy: new RetryPolicy(), getWorkerClient: () => worker1, onToolCall: (audit) => audits.push(audit) })
    const rpc = async (method: string, id: string | number, params: Record<string, unknown>) => {
      const response = await fetch(runtime.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      })
      return { status: response.status, body: await response.json() as Record<string, any> }
    }
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'chatgpt', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
      'openai/session': 'chat-modern',
    }
    try {
      const discover = await rpc('server/discover', 'openai-mcp-discover', { _meta: envelope })
      expect(discover.status).toBe(200)
      expect(discover.body.result).toMatchObject({
        resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, cacheScope: 'private', ttlMs: 0,
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'desktop-commander-manager', version: '0.1.0' } },
      })

      const listed = await rpc('tools/list', 1, { _meta: envelope })
      expect(listed.status).toBe(200)
      expect(listed.body.result).toMatchObject({ resultType: 'complete', cacheScope: 'private', ttlMs: 0 })
      expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo'])
      expect(listed.body.result.tools[0]).toMatchObject({ title: 'Echo tool', annotations: { title: 'Echo tool', readOnlyHint: true } })
      expect(listed.body.result.tools[0]._meta).toBeUndefined()

      const called = await rpc('tools/call', 2, { name: 'echo', arguments: { text: 'modern-hi', path: 'D:/repo/file.txt', command: 'curl --api-key do-not-store-this', content: 'do-not-store-this' }, _meta: envelope })
      expect(called.status).toBe(200)
      expect(called.body.result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'modern-hi' }] })
      expect(router.contexts.some((context) => context.sessionId === 'chat-modern')).toBe(true)
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ sessionId: 'chat-modern', workerId: 'worker-1', toolName: 'echo', argsSummary: 'path=D:/repo/file.txt | command=curl --api-key ***', status: 'OK', failedOver: false })
      expect(Number(audits[0].durationMs)).toBeGreaterThanOrEqual(0)
      expect(JSON.stringify(audits[0])).not.toContain('do-not-store-this')
    } finally { await runtime.close() }
  })

  it('forwards tool discovery/calls and extracts openai session metadata', async () => {
    const router = new FakeRouter(); const worker1 = fakeClient()
    const runtime = await createMcpHttpServer({ host: '127.0.0.1', port: 0, sessionRouter: router, retryPolicy: new RetryPolicy(), getWorkerClient: () => worker1 })
    try {
      const { client } = await connect(runtime)
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' }, _meta: { 'openai/session': 'chat-a' } as never })
      expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
      expect(router.contexts.some((context) => context.sessionId === 'chat-a' && context.connectionId.length > 0)).toBe(true)
      await client.close()
    } finally { await runtime.close() }
  })

  it('retries once on proven pre-dispatch failure using failover', async () => {
    const router = new FakeRouter(); const worker1 = fakeClient({ fail: 'PRE_DISPATCH' }); const worker2 = fakeClient({ text: 'from-worker-2' })
    const runtime = await createMcpHttpServer({ host: '127.0.0.1', port: 0, sessionRouter: router, retryPolicy: new RetryPolicy(), getWorkerClient: (id) => id === 'worker-1' ? worker1 : worker2 })
    try {
      const { client } = await connect(runtime)
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' }, _meta: { 'openai/session': 'chat-a' } as never })
      expect(result.content).toEqual([{ type: 'text', text: 'from-worker-2' }]); expect(router.failoverCalls).toHaveLength(1); expect(worker1.calls).toBe(1); expect(worker2.calls).toBe(1)
      await client.close()
    } finally { await runtime.close() }
  })

  it('does not replay ambiguous failures and returns an MCP error', async () => {
    const router = new FakeRouter(); const worker1 = fakeClient({ fail: 'ACK_UNKNOWN' })
    const runtime = await createMcpHttpServer({ host: '127.0.0.1', port: 0, sessionRouter: router, retryPolicy: new RetryPolicy(), getWorkerClient: () => worker1 })
    try {
      const { client } = await connect(runtime)
      await expect(client.callTool({ name: 'echo', arguments: { text: 'hi' }, _meta: { 'openai/session': 'chat-a' } as never })).rejects.toThrow()
      expect(router.failoverCalls).toHaveLength(0); expect(worker1.calls).toBe(1); await client.close()
    } finally { await runtime.close() }
  })

  it('returns a structured MCP error when no healthy worker exists', async () => {
    const router = new FakeRouter(); router.failResolve = true
    const runtime = await createMcpHttpServer({ host: '127.0.0.1', port: 0, sessionRouter: router, retryPolicy: new RetryPolicy(), getWorkerClient: () => fakeClient() })
    try {
      const { client } = await connect(runtime)
      await expect(client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow(/healthy|worker/i); await client.close()
    } finally { await runtime.close() }
  })
})

