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

export type ToolCallAudit = {
  sessionId: string
  workerId: string
  toolName: string
  argsSummary: string
  status: 'OK' | 'ERROR'
  durationMs: number
  failedOver: boolean
  error?: string
}

type McpHttpServerDeps = {
  host?: string
  port?: number
  sessionRouter: SessionRouterLike
  retryPolicy: RetryPolicy
  getWorkerClient(workerId: string): ProxyWorkerClient
  onToolCall?(audit: ToolCallAudit): void
}

type SessionRuntime = { transport: StreamableHTTPServerTransport; server: Server }

const SERVER_INFO = { name: 'desktop-commander-manager', version: '0.1.0' } as const
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const MODERN_ENVELOPE_META_KEYS = new Set([
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities',
])

function metaOf(request: { params?: { _meta?: Record<string, unknown> } }): Record<string, unknown> | undefined {
  return request.params?._meta
}

function sessionFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.['openai/session']
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function workerMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const filtered = Object.fromEntries(Object.entries(meta).filter(([key]) => !MODERN_ENVELOPE_META_KEYS.has(key)))
  return Object.keys(filtered).length ? filtered : undefined
}

const UNSUPPORTED_PROXY_TOOL_META_KEYS = new Set(['ui/resourceUri', 'openai/outputTemplate', 'openai/widgetAccessible', 'ui'])

function sanitizeToolDescriptor(tool: Record<string, unknown>): Record<string, unknown> {
  const annotations = tool.annotations && typeof tool.annotations === 'object' ? tool.annotations as Record<string, unknown> : undefined
  const title = typeof tool.title === 'string' && tool.title.trim()
    ? tool.title
    : typeof annotations?.title === 'string' && annotations.title.trim()
      ? annotations.title
      : undefined

  const rawMeta = tool._meta && typeof tool._meta === 'object' ? tool._meta as Record<string, unknown> : undefined
  const sanitizedMeta = rawMeta
    ? Object.fromEntries(Object.entries(rawMeta).filter(([key]) => !UNSUPPORTED_PROXY_TOOL_META_KEYS.has(key)))
    : undefined

  const { _meta: _ignoredMeta, ...rest } = tool
  return {
    ...rest,
    ...(title ? { title } : {}),
    ...(sanitizedMeta && Object.keys(sanitizedMeta).length ? { _meta: sanitizedMeta } : {}),
  }
}

async function listToolsThroughRouter(deps: McpHttpServerDeps, connectionId: string, meta: Record<string, unknown> | undefined) {
  const worker = await deps.sessionRouter.resolve({ sessionId: sessionFromMeta(meta), connectionId })
  const result = await deps.getWorkerClient(worker.id).listTools(workerMeta(meta))
  const raw = result as unknown as Record<string, unknown>
  const tools = Array.isArray(raw.tools) ? raw.tools.map((tool) => sanitizeToolDescriptor(tool as Record<string, unknown>)) : []
  return { ...raw, tools }
}

const TOOL_ARG_SUMMARY_KEYS = ['path', 'file_path', 'paths', 'command', 'mode', 'range', 'processId', 'pid', 'id', 'key', 'name'] as const

function redactSummaryText(value: string): string {
  return value
    .replace(/\b(password|passwd|pwd|token|api[_-]?key|secret)\s*[:=]\s*([^\s;]+)/gi, '$1=***')
    .replace(/(--(?:password|passwd|token|api-key|secret))\s+\S+/gi, '$1 ***')
    .replace(/\bBearer\s+\S+/gi, 'Bearer ***')
}

function summarizeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of TOOL_ARG_SUMMARY_KEYS) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const rawText = Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'object' ? '[object]' : String(value)
    const text = redactSummaryText(rawText)
    parts.push(`${key}=${text.length > 180 ? `${text.slice(0, 177)}...` : text}`)
    if (parts.length >= 3) break
  }
  return parts.join(' | ')
}

function emitToolCallAudit(deps: McpHttpServerDeps, audit: ToolCallAudit): void {
  try { deps.onToolCall?.(audit) } catch { /* Audit must never break the tool call. */ }
}

async function callToolThroughRouter(deps: McpHttpServerDeps, connectionId: string, name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined) {
  const sessionId = sessionFromMeta(meta) ?? createFallbackSessionId(connectionId)
  const startedAt = Date.now()
  let worker = await deps.sessionRouter.resolve({ sessionId: sessionFromMeta(meta), connectionId })
  let failedOver = false
  try {
    const result = await deps.getWorkerClient(worker.id).callTool(name, args, workerMeta(meta))
    emitToolCallAudit(deps, { sessionId, workerId: worker.id, toolName: name, argsSummary: summarizeToolArgs(args), status: 'OK', durationMs: Date.now() - startedAt, failedOver })
    return result
  } catch (error) {
    if (error instanceof UpstreamCallError && deps.retryPolicy.canReplay(error)) {
      worker = await deps.sessionRouter.failover(sessionId, worker.id)
      failedOver = true
      try {
        const result = await deps.getWorkerClient(worker.id).callTool(name, args, workerMeta(meta))
        emitToolCallAudit(deps, { sessionId, workerId: worker.id, toolName: name, argsSummary: summarizeToolArgs(args), status: 'OK', durationMs: Date.now() - startedAt, failedOver })
        return result
      } catch (retryError) {
        emitToolCallAudit(deps, { sessionId, workerId: worker.id, toolName: name, argsSummary: summarizeToolArgs(args), status: 'ERROR', durationMs: Date.now() - startedAt, failedOver, error: retryError instanceof Error ? retryError.message : String(retryError) })
        throw retryError
      }
    }
    emitToolCallAudit(deps, { sessionId, workerId: worker.id, toolName: name, argsSummary: summarizeToolArgs(args), status: 'ERROR', durationMs: Date.now() - startedAt, failedOver, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

function createProxyServer(deps: McpHttpServerDeps, getConnectionId: () => string): Server {
  const server = new Server({ name: 'desktop-commander-manager', version: '0.1.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      return await listToolsThroughRouter(deps, getConnectionId(), metaOf(request))
    } catch (error) {
      throw normalizeMcpError(error)
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callToolThroughRouter(deps, getConnectionId(), request.params.name, request.params.arguments ?? {}, metaOf(request))
    } catch (error) {
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

type JsonRpcRequestBody = {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: { _meta?: Record<string, unknown>; name?: unknown; arguments?: unknown }
}

function requestBody(body: unknown): JsonRpcRequestBody | undefined {
  return body && typeof body === 'object' ? body as JsonRpcRequestBody : undefined
}

function isModernRequest(body: unknown, headers: Record<string, unknown>): boolean {
  const parsed = requestBody(body)
  if (!parsed) return false
  if (parsed.method === 'server/discover') return true
  const metaVersion = parsed.params?._meta?.['io.modelcontextprotocol/protocolVersion']
  const headerVersion = headers['mcp-protocol-version']
  return metaVersion === MODERN_PROTOCOL_VERSION || headerVersion === MODERN_PROTOCOL_VERSION
}

function modernResultMeta(existing: unknown): Record<string, unknown> {
  const base = existing && typeof existing === 'object' ? existing as Record<string, unknown> : {}
  return { ...base, 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
}

function modernError(id: string | number | null | undefined, error: unknown, status = 200) {
  const normalized = normalizeMcpError(error)
  const data = (normalized as McpError & { data?: unknown }).data
  return {
    status,
    payload: { jsonrpc: '2.0', id: id ?? null, error: { code: normalized.code, message: normalized.message, ...(data === undefined ? {} : { data }) } },
  }
}

async function handleModernRequest(body: unknown, deps: McpHttpServerDeps) {
  const parsed = requestBody(body)
  const id = parsed?.id
  const method = parsed?.method
  const meta = parsed?.params?._meta
  const connectionId = `modern:${randomUUID()}`

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: {
        jsonrpc: '2.0', id,
        result: {
          resultType: 'complete', supportedVersions: [MODERN_PROTOCOL_VERSION], capabilities: { tools: {} },
          ttlMs: 0, cacheScope: 'private', _meta: modernResultMeta(undefined),
        },
      },
    }
  }

  if (method === 'tools/list') {
    try {
      const result = await listToolsThroughRouter(deps, connectionId, meta)
      const raw = result as unknown as Record<string, unknown>
      return {
        status: 200,
        payload: { jsonrpc: '2.0', id, result: { ...raw, resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: modernResultMeta(raw._meta) } },
      }
    } catch (error) {
      return modernError(id, error)
    }
  }

  if (method === 'tools/call') {
    const name = parsed?.params?.name
    if (typeof name !== 'string' || !name) return modernError(id, new McpError(ErrorCode.InvalidParams, 'Tool name is required'))
    const args = parsed?.params?.arguments
    const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    try {
      const result = await callToolThroughRouter(deps, connectionId, name, safeArgs, meta)
      const raw = result as unknown as Record<string, unknown>
      return {
        status: 200,
        payload: { jsonrpc: '2.0', id, result: { ...raw, resultType: 'complete', _meta: modernResultMeta(raw._meta) } },
      }
    } catch (error) {
      return modernError(id, error)
    }
  }

  return modernError(id, new McpError(ErrorCode.MethodNotFound, `Method not found: ${String(method)}`), 404)
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
      const headers = request.headers as Record<string, unknown>
      if (request.method === 'POST' && isModernRequest(request.body, headers)) {
        const response = await handleModernRequest(request.body, deps)
        reply.code(response.status).send(response.payload)
        return
      }

      const incomingSessionId = headerSessionId(headers)
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
