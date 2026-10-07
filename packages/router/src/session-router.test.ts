import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@dc-manager/database";
import type { ManagerDatabase } from "@dc-manager/database";
import type { WorkerDescriptor, WorkerRecord } from "@dc-manager/shared";
import { SessionRouter, createFallbackSessionId } from "./session-router";

const roots: string[] = [];
const now = "2026-09-29T00:00:00.000Z";

function record(
  id: string,
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    id,
    name: id,
    enabled: true,
    status: "READY",
    pid: 1,
    failureCount: 0,
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeWorkerPool {
  restartCalls: string[] = [];
  restartMode: "healthy" | "unhealthy" | "throw" = "healthy";
  constructor(private readonly db: ManagerDatabase) {}
  getHealthyWorkers(): WorkerDescriptor[] {
    return this.db.workers
      .listWorkers()
      .filter((w) => w.enabled && (w.status === "READY" || w.status === "BUSY"))
      .map((w) => ({
        ...w,
        activeSessionCount: this.db.sessions.countByWorker(w.id),
      }));
  }
  async restartWorker(id: string): Promise<void> {
    this.restartCalls.push(id);
    if (this.restartMode === "throw") throw new Error("restart failed");
    if (this.restartMode === "healthy")
      this.db.workers.setWorkerState(id, { status: "READY", pid: 99 });
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dc-router-"));
  roots.push(root);
  const db = createDatabase(join(root, "manager.db"));
  const pool = new FakeWorkerPool(db);
  return {
    db,
    pool,
    router: new SessionRouter({ database: db, workerManager: pool }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("SessionRouter", () => {
  it("keeps an existing healthy binding sticky and persists it across router instances", async () => {
    const { db, pool, router } = setup();
    db.workers.upsertWorker(record("worker-1"));
    const first = await router.resolve({
      sessionId: "chat-a",
      connectionId: "conn-1",
    });
    const second = await new SessionRouter({
      database: db,
      workerManager: pool,
    }).resolve({ sessionId: "chat-a", connectionId: "conn-1" });
    expect(first.id).toBe("worker-1");
    expect(second.id).toBe("worker-1");
    expect(db.sessions.getSession("chat-a")?.workerId).toBe("worker-1");
    db.close();
  });

  it("selects by least sessions, then failure count, then round-robin tie break", async () => {
    const { db, pool, router } = setup();
    db.workers.upsertWorker(record("worker-1", { failureCount: 0 }));
    db.workers.upsertWorker(record("worker-2", { failureCount: 2 }));
    db.sessions.upsertSession({
      sessionId: "existing",
      workerId: "worker-1",
      createdAt: now,
      lastUsedAt: now,
    });
    expect(
      (await router.resolve({ sessionId: "chat-a", connectionId: "c-a" })).id,
    ).toBe("worker-2");
    db.sessions.deleteSessionsForWorker("worker-1");
    db.sessions.deleteSessionsForWorker("worker-2");
    expect(
      (await router.resolve({ sessionId: "chat-b", connectionId: "c-b" })).id,
    ).toBe("worker-1");
    db.workers.upsertWorker(record("worker-2", { failureCount: 0 }));
    db.sessions.deleteSessionsForWorker("worker-1");
    db.sessions.deleteSessionsForWorker("worker-2");
    const tied1 = await router.resolve({
      sessionId: "tie-1",
      connectionId: "tie-c1",
    });
    db.sessions.deleteSessionsForWorker(tied1.id);
    const tied2 = await router.resolve({
      sessionId: "tie-2",
      connectionId: "tie-c2",
    });
    expect([tied1.id, tied2.id]).toEqual(["worker-1", "worker-2"]);
    db.close();
  });

  it("uses a connection-scoped fallback id and records missing session metadata", async () => {
    const { db, router } = setup();
    db.workers.upsertWorker(record("worker-1"));
    expect(createFallbackSessionId("conn-a")).toBe(
      createFallbackSessionId("conn-a"),
    );
    expect(createFallbackSessionId("conn-a")).not.toBe(
      createFallbackSessionId("conn-b"),
    );
    await router.resolve({ sessionId: "  ", connectionId: "conn-a" });
    const binding = db.sessions.listSessions()[0];
    expect(binding.sessionId).toBe(createFallbackSessionId("conn-a"));
    expect(
      db.events.listEvents().some((e) => e.type === "SESSION_KEY_MISSING"),
    ).toBe(true);
    db.close();
  });

  it("throws a structured error when no healthy worker exists", async () => {
    const { db, router } = setup();
    db.workers.upsertWorker(
      record("worker-1", { status: "OFFLINE", pid: null }),
    );
    await expect(
      router.resolve({ sessionId: "chat-a", connectionId: "c" }),
    ).rejects.toMatchObject({ code: "NO_HEALTHY_WORKER" });
    expect(db.sessions.listSessions()).toHaveLength(0);
    db.close();
  });

  it("keeps the binding when restart recovers the bound worker", async () => {
    const { db, pool, router } = setup();
    db.workers.upsertWorker(
      record("worker-1", { status: "DEGRADED", pid: null }),
    );
    db.workers.upsertWorker(record("worker-2"));
    db.sessions.upsertSession({
      sessionId: "chat-a",
      workerId: "worker-1",
      createdAt: now,
      lastUsedAt: now,
    });
    pool.restartMode = "healthy";
    expect(
      (await router.resolve({ sessionId: "chat-a", connectionId: "c" })).id,
    ).toBe("worker-1");
    expect(pool.restartCalls).toEqual(["worker-1"]);
    expect(db.sessions.getSession("chat-a")?.workerId).toBe("worker-1");
    db.close();
  });

  it("rebinds only after failed recovery and a replacement is healthy", async () => {
    const { db, pool, router } = setup();
    db.workers.upsertWorker(
      record("worker-1", { status: "DEGRADED", pid: null }),
    );
    db.workers.upsertWorker(record("worker-2"));
    db.sessions.upsertSession({
      sessionId: "chat-a",
      workerId: "worker-1",
      createdAt: now,
      lastUsedAt: now,
    });
    pool.restartMode = "throw";
    expect(
      (await router.resolve({ sessionId: "chat-a", connectionId: "c" })).id,
    ).toBe("worker-2");
    expect(db.sessions.getSession("chat-a")?.workerId).toBe("worker-2");
    expect(
      db.events.listEvents().some((e) => e.type === "SESSION_FAILOVER"),
    ).toBe(true);
    db.close();
  });
});
