import { describe, expect, it, vi } from 'vitest'
import type { RouteContext } from '@dc-manager/shared'
import type { NativeSidecarClient } from './native-sidecar.js'
import { RustMcpProxyBackend } from './rust-mcp-proxy-backend.js'

describe('RustMcpProxyBackend', () => {
  it('delegates listTools and callTool to native sidecar client', async () => {
    const fakeSidecar = {
      proxyListTools: vi.fn().mockResolvedValue({
        workerId: 'worker-1',
        result: { tools: [{ name: 'echo' }] },
      }),
      proxyCallTool: vi.fn().mockResolvedValue({
        workerId: 'worker-1',
        failedOver: false,
        result: { content: [{ type: 'text', text: 'hello' }] },
      }),
    } as unknown as NativeSidecarClient

    const backend = new RustMcpProxyBackend(fakeSidecar)
    const context: RouteContext = { connectionId: 'conn-1', sessionId: 'chat-1' }

    const listRes = await backend.listTools(context, { metaKey: 'metaVal' })
    expect(fakeSidecar.proxyListTools).toHaveBeenCalledWith(context, { metaKey: 'metaVal' })
    expect(listRes.workerId).toBe('worker-1')

    const callRes = await backend.callTool(context, 'echo', { text: 'hello' }, { metaKey: 'metaVal' })
    expect(fakeSidecar.proxyCallTool).toHaveBeenCalledWith(context, 'echo', { text: 'hello' }, { metaKey: 'metaVal' })
    expect(callRes.workerId).toBe('worker-1')
    expect(callRes.failedOver).toBe(false)
  })
})
