import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { WorkerProcessHandle } from "@dc-manager/worker-manager";
import { WorkerClient } from "./worker-client";

function fakeMcpHandle(): WorkerProcessHandle {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = "";
  stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "initialize")
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-worker", version: "1.0.0" } } })}\n`,
        );
      if (message.method === "tools/list")
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } })}\n`,
        );
      if (message.method === "tools/call")
        stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.text }] } })}\n`,
        );
    }
  });
  return {
    pid: 1,
    stdin,
    stdout,
    stderr,
    exited: new Promise(() => {}),
    async stop() {},
  };
}

describe("WorkerClient", () => {
  it("connects to an already-managed stdio worker and proxies tools", async () => {
    const client = await WorkerClient.connect(fakeMcpHandle());
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await client.callTool(
      "echo",
      { text: "hello" },
      { trace: "x" },
    );
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    await client.close();
  });
});
