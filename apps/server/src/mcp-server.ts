import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { createFallbackSessionId, UpstreamCallError, type RetryPolicy } from '@dc-manager/router'
import type { RouteContext, WorkerDescriptor } from '@dc-manager/shared'
import type { ProxyWorkerClient } from '@dc-manager/mcp-proxy'

interface SessionRouterLike {
  resolve(context: RouteContext): Promise<WorkerDescriptor>
  failover(sessionId: string, failedWorkerId: string): Promise<WorkerDescriptor>
}

type McpHttpServerDeps = {
  host?: string
  port?: number
  sessionRouter: SessionRouterLike
  retryPolicy: RetryPolicy
  getWorkerClient(workerId: string): ProxyWorkerClient
}

type SessionRuntime = { transport: StreamableHTTPServerTransport; server: Server }

function metaOf(request: { params?: { _meta?: Record<string, unknown> } }): Record<string, unknown> | undefined {
  return request.params?._meta
}

function sessionFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.['openai/session']
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function createProxyServer(deps: McpHttpServerDeps, getConnectionId: () => string): Server {
  const server = new Server({ name: 'desktop-commander-manager', version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const meta = metaOf(request)
    try {
      const worker = await deps.sessionRouter.resolve({ sessionId: sessionFromMeta(meta), connectionId: getConnectionId() })
      return await deps.getWorkerClient(worker.id).listTools(meta)
    } catch (error) {
      throw normalizeMcpError(error)
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const meta = metaOf(request)
    const connectionId = getConnectionId()
    const sessionId = sessionFromMeta(meta) ?? createFallbackSessionId(connectionId)
    let worker: WorkerDescriptor
    try {
      worker = await deps.sessionRouter.resolve({ sessionId: sessionFromMeta(meta), connectionId })
    } catch (error) {
      throw normalizeMcpError(error)
    }
    try {
      return await deps.getWorkerClient(worker.id).callTool(request.params.name, request.params.arguments ?? {}, meta)
    } catch (error) {
      if (error instanceof UpstreamCallError && deps.retryPolicy.canReplay(error)) {
        try {
          const replacement = await deps.sessionRouter.failover(sessionId, worker.id)
          return await deps.getWorkerClient(replacement.id).callTool(request.params.name, request.params.arguments ?? {}, meta)
        } catch (retryError) {
          throw normalizeMcpError(retryError)
        }
      }
      throw normalizeMcpError(error)
    }
  })
  return server
}

function normalizeMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new McpError(ErrorCode.InternalError, message)
}

function headerSessionId(headers: Record<string, unknown>): string | undefined {
  const value = headers['mcp-session-id']
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined
}

function isInitialize(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { method?: unknown }).method === 'initialize'
}

export async function createMcpHttpServer(deps: McpHttpServerDeps): Promise<{ url: string; close(): Promise<void> }> {
  const host = deps.host ?? '127.0.0.1'
  const port = deps.port ?? 8787
  const app = Fastify({ logger: false })
  const sessions = new Map<string, SessionRuntime>()
  const allSessions = new Set<SessionRuntime>()

  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp',
    handler: async (request, reply) => {
      const incomingSessionId = headerSessionId(request.headers as Record<string, unknown>)
      let runtime = incomingSessionId ? sessions.get(incomingSessionId) : undefined

      if (!runtime && !incomingSessionId && isInitialize(request.body)) {
        const pendingConnectionId = `connection:${randomUUID()}`
        let transport!: StreamableHTTPServerTransport
        const server = createProxyServer(deps, () => transport.sessionId ?? pendingConnectionId)
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, server }) },
          onsessionclosed: (sessionId) => { sessions.delete(sessionId) },
        })
        runtime = { transport, server }
        allSessions.add(runtime)
        await server.connect(transport)
      }

      if (!runtime) {
        reply.code(incomingSessionId ? 404 : 400).send({ jsonrpc: '2.0', error: { code: -32000, message: incomingSessionId ? 'Session not found' : 'MCP session not initialized' }, id: null })
        return
      }

      reply.hijack()
      await runtime.transport.handleRequest(request.raw, reply.raw, request.body)
    },
  })

  const address = await app.listen({ host, port })
  return {
    url: `${address}/mcp`,
    async close() {
      for (const runtime of allSessions) await runtime.server.close().catch(() => undefined)
      sessions.clear(); allSessions.clear(); await app.close()
    },
  }
}
