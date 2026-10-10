import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DesktopCommanderProcessFactory, WorkerProcessHandle } from "@dc-manager/worker-manager";
import { startManager, type ManagerRuntime } from "../../apps/server/src/main.js";
import { DuplicateOwnershipDetector } from "./fixtures/managed-child.js";

const roots: string[] = [];
const fakeScript = resolve("tests/fakes/fake-mcp-worker.ts");

class RecoveryProcessFactory implements DesktopCommanderProcessFactory {
  readonly startCounts = new Map<string, number>();
  readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  readonly failNextStart = new Set<string>();

  constructor(private readonly mutationFile: string) {}

  async start(workerId: string): Promise<WorkerProcessHandle> {
    this.startCounts.set(workerId, (this.startCounts.get(workerId) ?? 0) + 1);
    if (this.failNextStart.delete(workerId)) {
      throw new Error(`configured restart failure: ${workerId}`);
    }
    const child = spawn(process.execPath, ["--import", "tsx", fakeScript], {
      env: {
        ...process.env,
        FAKE_WORKER_ID: workerId,
        FAKE_MUTATION_FILE: this.mutationFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) throw new Error(`fake worker did not start: ${workerId}`);
    this.children.set(workerId, child);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );

    return {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await Promise.race([
          exited,
          new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
        ]);
      },
    };
  }

  crash(workerId: string): void {
    const child = this.children.get(workerId);
    if (!child || child.exitCode !== null) throw new Error(`worker is not running: ${workerId}`);
    child.kill();
  }
}

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "recovery-test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function identify(client: Client, sessionId: string): Promise<string> {
  const result = await client.callTool({
    name: "identify",
    arguments: {},
    _meta: { "openai/session": sessionId } as never,
  });
  const item = result.content[0];
  if (!item || item.type !== "text") throw new Error("identify did not return text");
  return item.text;
}

async function waitForStatus(
  runtime: ManagerRuntime,
  workerId: string,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (runtime.database.workers.getWorker(workerId)?.status === status) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(
    `Timed out waiting for ${workerId} -> ${status}; got ${runtime.database.workers.getWorker(workerId)?.status}`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("manager recovery fixtures", () => {
  it("recovers a crashed worker without re-binding session", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-rec-crash-"));
    roots.push(root);
    const factory = new RecoveryProcessFactory(join(root, "mutations.log"));
    const runtime = await startManager(
      {
        databasePath: join(root, "manager.db"),
        runtimeRoot: join(root, "workers"),
        mcpPort: 0,
        managementPort: 0,
        dashboardDir: join(root, "no-dashboard"),
      },
      { processFactory: factory },
    );
    const client = await connect(runtime.mcpUrl);

    try {
      const originalWorker = await identify(client, "session-rec");
      factory.crash(originalWorker);
      await waitForStatus(runtime, originalWorker, "DEGRADED");

      const postRecoverWorker = await identify(client, "session-rec");
      expect(postRecoverWorker).toBe(originalWorker);
      expect(factory.startCounts.get(originalWorker)).toBe(2);
      expect(runtime.database.sessions.getSession("session-rec")?.workerId).toBe(originalWorker);
      expect(
        runtime.database.events
          .listEvents()
          .filter((e) => e.type === "SESSION_FAILOVER" && e.sessionId === "session-rec"),
      ).toHaveLength(0);
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it("rebinds session to backup worker only after recovery fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-rec-failover-"));
    roots.push(root);
    const factory = new RecoveryProcessFactory(join(root, "mutations.log"));
    const runtime = await startManager(
      {
        databasePath: join(root, "manager.db"),
        runtimeRoot: join(root, "workers"),
        mcpPort: 0,
        managementPort: 0,
        dashboardDir: join(root, "no-dashboard"),
      },
      { processFactory: factory },
    );
    const client = await connect(runtime.mcpUrl);

    try {
      const original = await identify(client, "session-failover");
      const backup = original === "worker-1" ? "worker-2" : "worker-1";

      factory.failNextStart.add(original);
      factory.crash(original);
      await waitForStatus(runtime, original, "DEGRADED");

      const resolvedWorker = await identify(client, "session-failover");
      expect(resolvedWorker).toBe(backup);
      expect(runtime.database.sessions.getSession("session-failover")?.workerId).toBe(backup);
      expect(
        runtime.database.events
          .listEvents()
          .filter((e) => e.type === "SESSION_FAILOVER" && e.sessionId === "session-failover"),
      ).toHaveLength(1);
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it("does not replay ambiguous mutating calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-rec-mutation-"));
    roots.push(root);
    const mutationFile = join(root, "mutations.log");
    const factory = new RecoveryProcessFactory(mutationFile);
    const runtime = await startManager(
      {
        databasePath: join(root, "manager.db"),
        runtimeRoot: join(root, "workers"),
        mcpPort: 0,
        managementPort: 0,
        dashboardDir: join(root, "no-dashboard"),
      },
      { processFactory: factory },
    );
    const client = await connect(runtime.mcpUrl);

    try {
      await identify(client, "session-mutate");
      await expect(
        client.callTool({
          name: "ambiguous_mutation",
          arguments: {},
          _meta: { "openai/session": "session-mutate" } as never,
        }),
      ).rejects.toThrow();

      if (existsSync(mutationFile)) {
        const records = readFileSync(mutationFile, "utf-8").trim().split("\n").filter(Boolean);
        expect(records).toHaveLength(1);
      }
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  it("detects duplicate ownership contenders using the ownership detector fixture", () => {
    const detector = new DuplicateOwnershipDetector();
    expect(detector.tryClaim("contender-1")).toBe(true);
    expect(detector.getOwner()).toBe("contender-1");

    // Second contender fails to claim
    expect(detector.tryClaim("contender-2")).toBe(false);
    expect(detector.getOwner()).toBe("contender-1");

    // First contender releases, second contender can now claim
    detector.release("contender-1");
    expect(detector.getOwner()).toBeNull();
    expect(detector.tryClaim("contender-2")).toBe(true);
    expect(detector.getOwner()).toBe("contender-2");
  });
});
