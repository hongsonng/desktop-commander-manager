import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "@dc-manager/database";
import type { WorkerRecord } from "@dc-manager/shared";
import { createManagementApi } from "../../apps/server/src/management-api.js";
import { normalizeContractValue } from "./normalize.js";

const roots: string[] = [];
const fixedTime = "2026-09-29T00:00:00.000Z";

function createWorkerRecord(id: string): WorkerRecord {
  return {
    id,
    name: id,
    enabled: true,
    status: "READY",
    pid: 1234,
    failureCount: 0,
    lastHeartbeatAt: fixedTime,
    createdAt: fixedTime,
    updatedAt: fixedTime,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("management API contract", () => {
  it("freezes API contract JSON shapes and status codes", async () => {
    const root = mkdtempSync(join(tmpdir(), "dc-contract-api-"));
    roots.push(root);
    const db = createDatabase(join(root, "contract.sqlite"));

    db.workers.upsertWorker(createWorkerRecord("worker-1"));
    db.sessions.upsertSession({
      sessionId: "session-123",
      workerId: "worker-1",
      createdAt: fixedTime,
      lastUsedAt: fixedTime,
    });
    db.events.appendEvent({
      sessionId: null,
      workerId: "worker-1",
      type: "READY",
      message: "Worker ready",
      metadataJson: null,
      createdAt: fixedTime,
    });
    db.events.appendEvent({
      sessionId: "session-123",
      workerId: "worker-1",
      type: "TOOL_CALL",
      message: "execute_command OK",
      metadataJson: JSON.stringify({
        toolName: "execute_command",
        status: "OK",
        durationMs: 42,
        argsSummary: "echo hello",
        failedOver: false,
      }),
      createdAt: fixedTime,
    });

    const actionCalls: string[] = [];
    const resources = {
      async snapshot() {
        return {
          available: true,
          sampledAt: fixedTime,
          total: { memoryBytes: 200, cpuPercent: 2.0 },
          system: { memoryUsedBytes: 400, totalMemoryBytes: 16000, cpuPercent: 15.0 },
          items: [
            {
              id: "manager",
              label: "Manager",
              pid: 9999,
              memoryBytes: 200,
              cpuPercent: 2.0,
              processCount: 1,
              status: "running" as const,
            },
          ],
        };
      },
    };

    const dashboardDir = join(root, "dist");
    mkdirSync(dashboardDir, { recursive: true });
    writeFileSync(join(dashboardDir, "index.html"), "<!doctype html><title>CONTRACT_DASHBOARD</title>");

    const api = await createManagementApi({
      database: db,
      port: 0,
      dashboardDir,
      resources,
      connectionInfo: {
        mode: "direct-local",
        mcpUrl: "http://127.0.0.1:8787/mcp",
        workerStrategy: "sticky-failover",
      },
      actions: {
        async restart(id) { actionCalls.push(`restart:${id}`); },
        async enable(id) { actionCalls.push(`enable:${id}`); },
        async disable(id) { actionCalls.push(`disable:${id}`); },
      },
    });

    try {
      // GET /api/health
      const healthRes = await fetch(`${api.url}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthJson = normalizeContractValue(await healthRes.json());
      expect(healthJson).toEqual({
        status: "ok",
        startedAt: "[TIMESTAMP]",
        uptimeMs: "[UPTIME_MS]",
      });

      // GET /api/connection
      const connRes = await fetch(`${api.url}/api/connection`);
      expect(connRes.status).toBe(200);
      expect(normalizeContractValue(await connRes.json())).toEqual({
        mode: "direct-local",
        mcpUrl: "http://127.0.0.1:[PORT]/mcp",
        workerStrategy: "sticky-failover",
      });

      // GET /api/workers
      const workersRes = await fetch(`${api.url}/api/workers`);
      expect(workersRes.status).toBe(200);
      expect(normalizeContractValue(await workersRes.json())).toEqual([
        {
          id: "worker-1",
          name: "worker-1",
          enabled: true,
          status: "READY",
          pid: "[PID]",
          failureCount: 0,
          lastHeartbeatAt: "[TIMESTAMP]",
          createdAt: "[TIMESTAMP]",
          updatedAt: "[TIMESTAMP]",
          activeSessionCount: 1,
        },
      ]);

      // GET /api/resources
      const resRes = await fetch(`${api.url}/api/resources`);
      expect(resRes.status).toBe(200);
      expect(normalizeContractValue(await resRes.json())).toEqual({
        available: true,
        sampledAt: "[TIMESTAMP]",
        total: { memoryBytes: 200, cpuPercent: 2.0 },
        system: { memoryUsedBytes: 400, totalMemoryBytes: 16000, cpuPercent: 15.0 },
        items: [
          {
            id: "manager",
            label: "Manager",
            pid: "[PID]",
            memoryBytes: 200,
            cpuPercent: 2.0,
            processCount: 1,
            status: "running",
          },
        ],
      });

      // GET /api/sessions
      const sessRes = await fetch(`${api.url}/api/sessions`);
      expect(sessRes.status).toBe(200);
      expect(normalizeContractValue(await sessRes.json())).toEqual([
        {
          sessionId: "session-123",
          workerId: "worker-1",
          createdAt: "[TIMESTAMP]",
          lastUsedAt: "[TIMESTAMP]",
        },
      ]);

      // GET /api/events
      const eventsRes = await fetch(`${api.url}/api/events`);
      expect(eventsRes.status).toBe(200);
      expect(normalizeContractValue(await eventsRes.json())).toEqual([
        {
          id: expect.any(Number),
          sessionId: null,
          workerId: "worker-1",
          type: "READY",
          message: "Worker ready",
          metadataJson: null,
          createdAt: "[TIMESTAMP]",
        },
      ]);

      // GET /api/tool-calls
      const toolCallsRes = await fetch(`${api.url}/api/tool-calls`);
      expect(toolCallsRes.status).toBe(200);
      expect(normalizeContractValue(await toolCallsRes.json())).toEqual([
        {
          id: expect.any(Number),
          sessionId: "session-123",
          workerId: "worker-1",
          toolName: "execute_command",
          status: "OK",
          durationMs: 42,
          argsSummary: "echo hello",
          failedOver: false,
          error: null,
          createdAt: "[TIMESTAMP]",
        },
      ]);

      // Actions: POST /api/workers/:id/restart, enable, disable
      for (const action of ["restart", "enable", "disable"]) {
        const actionRes = await fetch(`${api.url}/api/workers/worker-1/${action}`, {
          method: "POST",
        });
        expect(actionRes.status).toBe(200);
      }
      expect(actionCalls).toEqual(["restart:worker-1", "enable:worker-1", "disable:worker-1"]);

      // 404 for unknown worker
      const notFoundRes = await fetch(`${api.url}/api/workers/unknown-worker/restart`, {
        method: "POST",
      });
      expect(notFoundRes.status).toBe(404);

      // Dashboard static root
      const rootRes = await fetch(`${api.url}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toContain("CONTRACT_DASHBOARD");
    } finally {
      await api.close();
      db.close();
    }
  });
});
