import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startManager, type ManagerRuntime } from "../../apps/server/src/main.js";

const roots: string[] = [];

afterEach(() => {
  delete process.env.DCM_WORKER_COMMAND;
  delete process.env.DCM_WORKER_ARGS;
  for (const root of roots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  roots.length = 0;
});

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "rust-recovery-test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("Rust Worker Supervisor Recovery Gate", () => {
  const releaseExe = resolve(process.cwd(), "target", "release", "dcm-manager.exe");
  const debugExe = resolve(process.cwd(), "target", "debug", "dcm-manager.exe");
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe;
  const fakeWorker = resolve(process.cwd(), "tests", "fakes", "fake-mcp-worker.mjs");

  it(
    "supervises workers via Rust, detects crash, and recovers to READY within 5s",
    async () => {
      if (!existsSync(exePath)) {
        console.warn("Skipping test: dcm-manager.exe not built yet");
        return;
      }

      const root = mkdtempSync(join(tmpdir(), "dcm-rust-recovery-"));
      roots.push(root);

      process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.TestRecovery.${process.pid}`;
      process.env.DCM_WORKER_COMMAND = process.execPath;
      process.env.DCM_WORKER_ARGS = JSON.stringify([fakeWorker]);

      const runtime: ManagerRuntime = await startManager({
        databasePath: join(root, "manager.db"),
        runtimeRoot: join(root, "workers"),
        mcpPort: 0,
        managementPort: 0,
        platformOwner: "rust",
        workerOwner: "rust",
        nativeSidecarPath: exePath,
      });

      try {
        // 1. Verify both workers started and handshook to READY
        const workers = await runtime.state.listWorkers();
        expect(workers).toHaveLength(2);
        expect(workers.every((w) => w.enabled)).toBe(true);

        const worker1 = await runtime.state.getWorker("worker-1");
        expect(worker1).toBeDefined();
        expect(worker1?.status).toBe("READY");
        expect(worker1?.pid).toBeGreaterThan(0);

      // 2. Connect client and perform tool call
      const client = await connect(runtime.mcpUrl);
      const tools = await client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);

      const configRes = await client.callTool({
        name: "identify",
        arguments: {},
      });
      expect(configRes.isError).toBeFalsy();

      // 3. Intentionally kill worker-1 process
      const initialPid = worker1!.pid!;
      const startTime = Date.now();
      process.kill(initialPid);

      // 4. Wait for Rust supervisor to detect crash and recover to READY
      let recovered = false;
      let newPid: number | null = null;
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        const current = await runtime.state.getWorker("worker-1");
        if (current && current.status === "READY" && current.pid && current.pid !== initialPid) {
          recovered = true;
          newPid = current.pid;
          break;
        }
        await new Promise((res) => setTimeout(res, 50));
      }

      const recoveryDurationMs = Date.now() - startTime;
      expect(recovered).toBe(true);
      expect(newPid).toBeGreaterThan(0);
      expect(recoveryDurationMs).toBeLessThan(5000);

      // 5. Verify subsequent call succeeds
      const postRecoveryRes = await client.callTool({
        name: "identify",
        arguments: {},
      });
      expect(postRecoveryRes.isError).toBeFalsy();

      await client.close();
    } finally {
      await runtime.close();
    }
  },
  15000,
);
});
