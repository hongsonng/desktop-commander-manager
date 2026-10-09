import { join, resolve } from "node:path";
import type { ManagerDatabase } from "@dc-manager/database";
import type { WorkerDescriptor, WorkerRecord } from "@dc-manager/shared";
import type {
  DesktopCommanderProcessFactory,
  WorkerExit,
  WorkerProcessHandle,
} from "./desktop-commander-process.js";

type WorkerManagerOptions = {
  database: ManagerDatabase;
  processFactory: DesktopCommanderProcessFactory;
  runtimeRoot: string;
};

export class WorkerManager {
  private readonly handles = new Map<string, WorkerProcessHandle>();
  private readonly intentionalStops = new Set<string>();
  private readonly runtimeRoot: string;

  constructor(private readonly options: WorkerManagerOptions) {
    this.runtimeRoot = resolve(options.runtimeRoot);
  }

  async startWorker(id: string): Promise<WorkerProcessHandle> {
    const current = this.requireWorker(id);
    if (!current.enabled || current.status === "DISABLED")
      throw new Error(`Worker is disabled: ${id}`);
    const existing = this.handles.get(id);
    if (existing) return existing;
    this.options.database.workers.setWorkerState(id, {
      status: "STARTING",
      pid: null,
    });
    this.event(id, "WORKER_STARTING", `Starting ${id}`);
    try {
      const handle = await this.options.processFactory.start(
        id,
        join(this.runtimeRoot, id),
      );
      this.handles.set(id, handle);
      this.options.database.workers.setWorkerState(id, {
        status: "STARTING",
        pid: handle.pid,
      });
      void handle.exited.then((exit) =>
        this.onUnexpectedExit(id, handle, exit),
      );
      return handle;
    } catch (error) {
      this.options.database.workers.setWorkerState(id, {
        status: "OFFLINE",
        pid: null,
        failureCount: current.failureCount + 1,
      });
      this.event(
        id,
        "WORKER_START_FAILED",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async stopWorker(id: string): Promise<void> {
    const current = this.requireWorker(id);
    const handle = this.handles.get(id);
    if (handle) {
      this.intentionalStops.add(id);
      try {
        await handle.stop();
      } finally {
        this.handles.delete(id);
      }
    }
    this.options.database.workers.setWorkerState(id, {
      status: current.enabled ? "STOPPED" : "DISABLED",
      pid: null,
    });
    this.event(id, "WORKER_STOPPED", `Stopped ${id}`);
  }

  async restartWorker(id: string): Promise<WorkerProcessHandle> {
    await this.stopWorker(id);
    this.event(id, "WORKER_RESTART", `Restarting ${id}`);
    return this.startWorker(id);
  }

  async disableWorker(id: string): Promise<void> {
    const current = this.requireWorker(id);
    const handle = this.handles.get(id);
    if (handle) {
      this.intentionalStops.add(id);
      try {
        await handle.stop();
      } finally {
        this.handles.delete(id);
      }
    }
    this.options.database.workers.upsertWorker({
      ...current,
      enabled: false,
      status: "DISABLED",
      pid: null,
      updatedAt: new Date().toISOString(),
    });
    this.event(id, "WORKER_DISABLED", `Disabled ${id}`);
  }

  enableWorker(id: string): void {
    const current = this.requireWorker(id);
    this.options.database.workers.upsertWorker({
      ...current,
      enabled: true,
      status: "STOPPED",
      pid: null,
      updatedAt: new Date().toISOString(),
    });
    this.event(id, "WORKER_ENABLED", `Enabled ${id}`);
  }

  markReady(id: string): void {
    this.requireWorker(id);
    this.options.database.workers.setWorkerState(id, {
      status: "READY",
      lastHeartbeatAt: new Date().toISOString(),
    });
    this.event(id, "WORKER_READY", `${id} MCP handshake ready`);
  }

  markBusy(id: string): void {
    this.requireWorker(id);
    this.options.database.workers.setWorkerState(id, { status: "BUSY" });
  }
  async degradeWorker(id: string, message: string): Promise<void> {
    const current = this.requireWorker(id);
    const handle = this.handles.get(id);
    if (handle) {
      this.intentionalStops.add(id);
      try {
        await handle.stop();
      } finally {
        this.handles.delete(id);
      }
    }
    this.options.database.workers.setWorkerState(id, {
      status: "DEGRADED",
      pid: null,
      failureCount: current.failureCount + 1,
    });
    this.event(id, "WORKER_DEGRADED", message);
  }

  getHealthyWorkers(): WorkerDescriptor[] {
    return this.options.database.workers
      .listWorkers()
      .filter(
        (worker) =>
          worker.enabled &&
          (worker.status === "READY" || worker.status === "BUSY"),
      )
      .map((worker) => ({
        ...worker,
        activeSessionCount: this.options.database.sessions.countByWorker(
          worker.id,
        ),
      }));
  }

  getHandle(id: string): WorkerProcessHandle | undefined {
    return this.handles.get(id);
  }

  private requireWorker(id: string): WorkerRecord {
    const worker = this.options.database.workers.getWorker(id);
    if (!worker) throw new Error(`Unknown worker: ${id}`);
    return worker;
  }

  private onUnexpectedExit(
    id: string,
    handle: WorkerProcessHandle,
    exit: WorkerExit,
  ): void {
    if (this.handles.get(id) !== handle) return;
    this.handles.delete(id);
    if (this.intentionalStops.delete(id)) return;
    const current = this.options.database.workers.getWorker(id);
    if (!current) return;
    this.options.database.workers.setWorkerState(id, {
      status: "DEGRADED",
      pid: null,
      failureCount: current.failureCount + 1,
    });
    this.event(id, "WORKER_EXIT", `${id} exited unexpectedly`, {
      code: exit.code,
      signal: exit.signal,
    });
  }

  private event(
    workerId: string,
    type: string,
    message: string,
    metadata?: unknown,
  ): void {
    this.options.database.events.appendEvent({
      sessionId: null,
      workerId,
      type,
      message,
      metadataJson: metadata === undefined ? null : JSON.stringify(metadata),
      createdAt: new Date().toISOString(),
    });
  }
}
