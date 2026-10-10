import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { DesktopCommanderProcessFactory, WorkerProcessHandle } from "@dc-manager/worker-manager";
import { startManager, type ManagerRuntime } from "../../apps/server/src/main.js";

const fakeScript = resolve("tests/fakes/fake-mcp-worker.ts");

export class FastFakeProcessFactory implements DesktopCommanderProcessFactory {
  readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  readonly startCounts = new Map<string, number>();

  async start(workerId: string): Promise<WorkerProcessHandle> {
    this.startCounts.set(workerId, (this.startCounts.get(workerId) ?? 0) + 1);
    const child = spawn(process.execPath, ["--import", "tsx", fakeScript], {
      env: { ...process.env, FAKE_WORKER_ID: workerId },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.set(workerId, child);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );

    return {
      pid: child.pid!,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await Promise.race([exited, new Promise((res) => setTimeout(res, 1000))]);
      },
    };
  }

  crash(workerId: string): void {
    const child = this.children.get(workerId);
    if (child && child.exitCode === null) {
      child.kill();
    }
  }
}

export class IsolatedManagerInstance {
  readonly root: string;
  readonly factory: FastFakeProcessFactory;
  runtime?: ManagerRuntime;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "dc-bench-host-"));
    this.factory = new FastFakeProcessFactory();
  }

  async start(): Promise<{ mcpUrl: string; managementUrl: string; pid: number }> {
    this.runtime = await startManager(
      {
        databasePath: join(this.root, "manager.db"),
        runtimeRoot: join(this.root, "workers"),
        mcpPort: 0,
        managementPort: 0,
        dashboardDir: join(this.root, "no-dashboard"),
      },
      { processFactory: this.factory },
    );
    return {
      mcpUrl: this.runtime.mcpUrl,
      managementUrl: this.runtime.managementUrl,
      pid: process.pid,
    };
  }

  async close(): Promise<void> {
    await this.runtime?.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}
