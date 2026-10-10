import type { RouteContext } from '@dc-manager/shared'
import type { McpProxyBackend, ProxyCallToolResult, ProxyListToolsResult } from './mcp-proxy-backend.js'
import type { NativeSidecarClient } from './native-sidecar.js'

export class RustMcpProxyBackend implements McpProxyBackend {
  constructor(private readonly sidecar: NativeSidecarClient) {}

  async listTools(
    context: RouteContext,
    meta?: Record<string, unknown>,
  ): Promise<ProxyListToolsResult> {
    return this.sidecar.proxyListTools(context, meta)
  }

  async callTool(
    context: RouteContext,
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ProxyCallToolResult> {
    return this.sidecar.proxyCallTool(context, name, args, meta)
  }
}
