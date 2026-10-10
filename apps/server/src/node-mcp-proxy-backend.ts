import { createFallbackSessionId, UpstreamCallError, type RetryPolicy } from '@dc-manager/router'
import type { ProxyWorkerClient } from '@dc-manager/mcp-proxy'
import type { RouteContext, WorkerDescriptor } from '@dc-manager/shared'
import type { McpProxyBackend, ProxyCallToolResult, ProxyListToolsResult } from './mcp-proxy-backend.js'

export interface SessionRouterLike {
  resolve(context: RouteContext): Promise<WorkerDescriptor>
  failover(sessionId: string, failedWorkerId: string): Promise<WorkerDescriptor>
}

export class NodeMcpProxyBackend implements McpProxyBackend {
  constructor(
    private readonly sessionRouter: SessionRouterLike,
    private readonly retryPolicy: RetryPolicy,
    private readonly getWorkerClient: (workerId: string) => ProxyWorkerClient,
  ) {}

  async listTools(
    context: RouteContext,
    meta?: Record<string, unknown>,
  ): Promise<ProxyListToolsResult> {
    const worker = await this.sessionRouter.resolve(context)
    const client = this.getWorkerClient(worker.id)
    try {
      const result = await client.listTools(meta)
      return { workerId: worker.id, result: result as unknown as { tools: unknown[] } }
    } catch (error) {
      if (error instanceof UpstreamCallError && this.retryPolicy.canReplay(error)) {
        const sessionId = context.sessionId?.trim() || createFallbackSessionId(context.connectionId)
        const failoverWorker = await this.sessionRouter.failover(sessionId, worker.id)
        const failoverClient = this.getWorkerClient(failoverWorker.id)
        const retryResult = await failoverClient.listTools(meta)
        return { workerId: failoverWorker.id, result: retryResult as unknown as { tools: unknown[] } }
      }
      throw error
    }
  }

  async callTool(
    context: RouteContext,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ProxyCallToolResult> {
    const sessionId = context.sessionId?.trim() || createFallbackSessionId(context.connectionId)
    let worker: WorkerDescriptor | undefined
    let failedOver = false
    try {
      worker = await this.sessionRouter.resolve(context)
      const result = await this.getWorkerClient(worker.id).callTool(name, args, meta)
      return {
        workerId: worker.id,
        failedOver,
        result: result as unknown as { content: unknown[]; isError?: boolean },
      }
    } catch (error) {
      if (error instanceof UpstreamCallError && this.retryPolicy.canReplay(error) && worker) {
        try {
          worker = await this.sessionRouter.failover(sessionId, worker.id)
          failedOver = true
          const result = await this.getWorkerClient(worker.id).callTool(name, args, meta)
          return {
            workerId: worker.id,
            failedOver,
            result: result as unknown as { content: unknown[]; isError?: boolean },
          }
        } catch (retryError) {
          if (retryError && typeof retryError === 'object') {
            (retryError as Record<string, unknown>).workerId = worker.id
            ;(retryError as Record<string, unknown>).failedOver = true
          }
          throw retryError
        }
      }
      if (worker && error && typeof error === 'object') {
        (error as Record<string, unknown>).workerId = worker.id
      }
      throw error
    }
  }
}
