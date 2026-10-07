import { describe, expect, it } from "vitest";
import { WORKER_STATUSES } from "./types";
import type { EventRecord, SessionBinding, WorkerRecord } from "./types";

describe("shared domain contracts", () => {
  it("defines the allowed worker states", () => {
    expect(WORKER_STATUSES).toEqual([
      "STOPPED",
      "STARTING",
      "READY",
      "BUSY",
      "DEGRADED",
      "OFFLINE",
      "DISABLED",
    ]);
  });

  it("supports serializable worker, session, and event records", () => {
    const worker = {
      id: "worker-1",
      name: "Worker 1",
      enabled: true,
      status: "READY",
      pid: 123,
      failureCount: 0,
      lastHeartbeatAt: null,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
    } satisfies WorkerRecord;
    const session = {
      sessionId: "chat-a",
      workerId: "worker-1",
      createdAt: "2026-09-29T00:00:00.000Z",
      lastUsedAt: "2026-09-29T00:00:00.000Z",
    } satisfies SessionBinding;
    const event = {
      id: 1,
      sessionId: "chat-a",
      workerId: "worker-1",
      type: "SESSION_BOUND",
      message: "bound",
      metadataJson: null,
      createdAt: "2026-09-29T00:00:00.000Z",
    } satisfies EventRecord;
    expect(JSON.parse(JSON.stringify({ worker, session, event }))).toEqual({
      worker,
      session,
      event,
    });
  });
});
