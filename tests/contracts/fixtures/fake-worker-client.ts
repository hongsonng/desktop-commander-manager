import { UpstreamCallError } from "@dc-manager/router";
import type { ProxyWorkerClient, WorkerToolResult, WorkerToolsResult } from "@dc-manager/mcp-proxy";

export interface FakeWorkerClientOptions {
  fail?: "PRE_DISPATCH" | "ACK_UNKNOWN";
  text?: string;
  withUiMeta?: boolean;
}

export class FakeContractWorkerClient implements ProxyWorkerClient {
  calls = 0;

  constructor(private readonly options: FakeWorkerClientOptions = {}) {}

  async listTools(): Promise<WorkerToolsResult> {
    return {
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          annotations: { title: "Echo tool", readOnlyHint: true },
          ...(this.options.withUiMeta
            ? {
                _meta: {
                  "ui/resourceUri": "ui://desktop-commander/echo",
                  "openai/outputTemplate": "ui://desktop-commander/echo",
                  "openai/widgetAccessible": true,
                  ui: { resourceUri: "ui://desktop-commander/echo" },
                },
              }
            : {}),
        },
      ],
    } as unknown as WorkerToolsResult;
  }

  async callTool(_name: string, args: Record<string, unknown>): Promise<WorkerToolResult> {
    this.calls++;
    if (this.options.fail) {
      throw new UpstreamCallError(this.options.fail, "upstream failure");
    }
    return {
      content: [{ type: "text", text: this.options.text ?? String(args.text ?? "") }],
    } as unknown as WorkerToolResult;
  }

  async close(): Promise<void> {}
}
