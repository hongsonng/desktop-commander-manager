import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { RetryPolicy } from "@dc-manager/router";
import { createMcpHttpServer } from "../../apps/server/src/mcp-server.js";
import { FakeContractRouter } from "./fixtures/fake-router.js";
import { FakeContractWorkerClient } from "./fixtures/fake-worker-client.js";

async function connectClient(url: string) {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "contract-test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("MCP ingress contract", () => {
  describe("modern protocol 2026-07-28", () => {
    it("freezes server/discover, tools/list, and tools/call contract shapes", async () => {
      const router = new FakeContractRouter();
      const worker = new FakeContractWorkerClient({ withUiMeta: true });
      const audits: Array<Record<string, unknown>> = [];

      const runtime = await createMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        sessionRouter: router,
        retryPolicy: new RetryPolicy(),
        getWorkerClient: () => worker,
        onToolCall: (audit) => audits.push(audit),
      });

      const rpc = async (method: string, id: string | number, params: Record<string, unknown>) => {
        const response = await fetch(runtime.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      };

      const envelope = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "chatgpt", version: "1.0.0" },
        "openai/session": "modern-session-1",
      };

      try {
        // server/discover
        const discover = await rpc("server/discover", "discover-1", { _meta: envelope });
        expect(discover.status).toBe(200);
        expect(discover.body.result).toMatchObject({
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          capabilities: { tools: {} },
          cacheScope: "private",
          ttlMs: 0,
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "desktop-commander-manager",
              version: "0.1.0",
            },
          },
        });

        // tools/list
        const list = await rpc("tools/list", "list-1", { _meta: envelope });
        expect(list.status).toBe(200);
        expect(list.body.result).toMatchObject({
          resultType: "complete",
          cacheScope: "private",
          ttlMs: 0,
        });
        expect(list.body.result.tools).toHaveLength(1);
        expect(list.body.result.tools[0].name).toBe("echo");
        expect(list.body.result.tools[0].annotations).toEqual({
          title: "Echo tool",
          readOnlyHint: true,
        });
        // Upstream metadata like _meta should be stripped by manager for safety
        expect(list.body.result.tools[0]._meta).toBeUndefined();

        // tools/call
        const call = await rpc("tools/call", "call-1", {
          name: "echo",
          arguments: { text: "hello modern" },
          _meta: envelope,
        });
        expect(call.status).toBe(200);
        expect(call.body.result).toMatchObject({
          resultType: "complete",
          content: [{ type: "text", text: "hello modern" }],
        });

        expect(router.contexts.some((ctx) => ctx.sessionId === "modern-session-1")).toBe(true);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          sessionId: "modern-session-1",
          workerId: "worker-1",
          toolName: "echo",
          status: "OK",
          failedOver: false,
        });
      } finally {
        await runtime.close();
      }
    });
  });

  describe("Streamable HTTP transport & replay safety", () => {
    it("handles tools discovery and call with sticky openai session", async () => {
      const router = new FakeContractRouter();
      const worker = new FakeContractWorkerClient();
      const runtime = await createMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        sessionRouter: router,
        retryPolicy: new RetryPolicy(),
        getWorkerClient: () => worker,
      });

      try {
        const { client } = await connectClient(runtime.url);
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["echo"]);

        const callResult = await client.callTool({
          name: "echo",
          arguments: { text: "streamable-hi" },
          _meta: { "openai/session": "sticky-session-a" } as never,
        });
        expect(callResult.content).toEqual([{ type: "text", text: "streamable-hi" }]);
        expect(router.contexts.some((ctx) => ctx.sessionId === "sticky-session-a")).toBe(true);
        await client.close();
      } finally {
        await runtime.close();
      }
    });

    it("fails over once on PRE_DISPATCH failure", async () => {
      const router = new FakeContractRouter();
      const worker1 = new FakeContractWorkerClient({ fail: "PRE_DISPATCH" });
      const worker2 = new FakeContractWorkerClient({ text: "from-worker-2" });

      const runtime = await createMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        sessionRouter: router,
        retryPolicy: new RetryPolicy(),
        getWorkerClient: (id) => (id === "worker-1" ? worker1 : worker2),
      });

      try {
        const { client } = await connectClient(runtime.url);
        const res = await client.callTool({
          name: "echo",
          arguments: { text: "pre-dispatch-test" },
          _meta: { "openai/session": "session-failover" } as never,
        });
        expect(res.content).toEqual([{ type: "text", text: "from-worker-2" }]);
        expect(router.failoverCalls).toHaveLength(1);
        expect(worker1.calls).toBe(1);
        expect(worker2.calls).toBe(1);
        await client.close();
      } finally {
        await runtime.close();
      }
    });

    it("never replays an ACK_UNKNOWN failure", async () => {
      const router = new FakeContractRouter();
      const worker1 = new FakeContractWorkerClient({ fail: "ACK_UNKNOWN" });
      const worker2 = new FakeContractWorkerClient({ text: "should-not-reach" });

      const runtime = await createMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        sessionRouter: router,
        retryPolicy: new RetryPolicy(),
        getWorkerClient: (id) => (id === "worker-1" ? worker1 : worker2),
      });

      try {
        const { client } = await connectClient(runtime.url);
        await expect(
          client.callTool({
            name: "echo",
            arguments: { text: "ack-unknown-test" },
            _meta: { "openai/session": "session-no-replay" } as never,
          }),
        ).rejects.toThrow();

        expect(router.failoverCalls).toHaveLength(0);
        expect(worker1.calls).toBe(1);
        expect(worker2.calls).toBe(0);
        await client.close();
      } finally {
        await runtime.close();
      }
    });

    it("returns structured error when no worker is healthy", async () => {
      const router = new FakeContractRouter();
      router.failResolve = true;
      const worker = new FakeContractWorkerClient();

      const runtime = await createMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        sessionRouter: router,
        retryPolicy: new RetryPolicy(),
        getWorkerClient: () => worker,
      });

      try {
        const { client } = await connectClient(runtime.url);
        await expect(
          client.callTool({
            name: "echo",
            arguments: { text: "test" },
          }),
        ).rejects.toThrow("No healthy Desktop Commander worker is available");
        await client.close();
      } finally {
        await runtime.close();
      }
    });
  });
});
