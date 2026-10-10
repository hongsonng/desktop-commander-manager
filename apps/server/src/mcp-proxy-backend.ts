import type { RouteContext } from '@dc-manager/shared'

export interface ProxyListToolsResult {
  workerId: string
  result: { tools: unknown[]; [key: string]: unknown }
}

export interface ProxyCallToolResult {
  workerId: string
  failedOver: boolean
  result: { content: unknown[]; isError?: boolean; [key: string]: unknown }
}

export interface McpProxyBackend {
  listTools(
    context: RouteContext,
    meta?: Record<string, unknown>,
  ): Promise<ProxyListToolsResult>

  callTool(
    context: RouteContext,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ProxyCallToolResult>
}
