# Desktop Commander Manager — Design Spec

## 1. Goal

Build a Windows-first application that exposes one MCP endpoint to ChatGPT and routes Desktop Commander tool calls to isolated local workers without requiring the user to switch accounts or processes manually.

The routing unit is the ChatGPT conversation. Calls carrying the same `_meta["openai/session"]` value stay bound to the same worker until that worker can no longer serve the session.

If a worker fails, the manager automatically restarts it and, if recovery fails, rebinds the conversation to another healthy worker.

## 2. Scope

### In scope

- One MCP connector visible to ChatGPT.
- Sticky routing by anonymized ChatGPT session id.
- Multiple isolated Desktop Commander local MCP workers.
- Worker lifecycle management: start, stop, restart, health, disable.
- Automatic worker failover.
- Persistent session-to-worker bindings.
- Audit/event logging.
- Local web dashboard for workers, sessions, and events.
- Windows process isolation and per-worker directories.

### Out of scope for MVP

- Aggregating or bypassing third-party Remote MCP account quotas.
- Automatic switching between hosted Desktop Commander accounts to extend quota.
- System tray/Tauri packaging.
- Multi-machine orchestration.
- Cloud-hosted control plane.

## 3. Runtime Architecture

```text
ChatGPT
   |
   v
MCP Router :8787
   |
   +-- Session Router
   |     openai/session -> workerId
   |
   +-- Worker Manager
   |     lifecycle / health / retry / failover
   |
   +-- Persistence
   |     SQLite
   |
   +-- Dashboard API :8788
         |
         +-- Worker status
         +-- Session bindings
         +-- Event stream

Workers
   +-- worker-1 -> Desktop Commander Local MCP
   +-- worker-2 -> Desktop Commander Local MCP
```

The MCP Router is the only endpoint configured in ChatGPT. It owns request correlation and delegates execution to one worker at a time.

Workers are local child processes controlled by the Worker Manager. A worker never decides routing itself.

### Transport decisions

- Router exposes MCP Streamable HTTP at `http://127.0.0.1:8787/mcp`.
- ChatGPT reaches the private Router through OpenAI Secure MCP Tunnel during MVP; no inbound public port is required.
- Each Desktop Commander worker is spawned as a stdio MCP server with `npx -y @wonderwhy-er/desktop-commander@latest --no-onboarding`.
- Router communicates with each worker using MCP stdio transport through the child process stdin/stdout pipes.
- Management/dashboard HTTP remains separate from the MCP transport and binds to loopback only.

The tunnel configuration is deployment configuration, not routing state. The manager remains usable with MCP Inspector locally even when no tunnel is running.

## 4. Session Routing

### Session key

The router reads `_meta["openai/session"]` from each MCP request. This value is treated as an opaque session identifier; it is never parsed for user information.

If the field is missing, the router creates a short-lived fallback session id scoped to the current connection and records an event with type `SESSION_KEY_MISSING`.

### Binding rules

1. Existing binding + healthy worker: reuse the worker.
2. Existing binding + degraded worker: attempt one controlled restart.
3. Restart succeeds: keep the same binding and retry once.
4. Restart fails: select another healthy worker, update the binding, then retry once.
5. No existing binding: select the least-loaded healthy worker.
6. No healthy worker: return a structured MCP error and do not create a binding.

A session binding survives manager restarts because it is persisted in SQLite.

### New-session worker selection

Workers eligible for assignment must be `READY` or `BUSY` and not administratively disabled.

Selection order:

1. Lowest active-session count.
2. Lowest recent failure count.
3. Round-robin tie breaker.

This avoids hard-coding a primary worker and keeps load reasonably balanced without introducing complex scheduling.

## 5. Worker Lifecycle

Worker states:

```text
STOPPED -> STARTING -> READY <-> BUSY
                      |
                      v
                   DEGRADED
                      |
                   restart
                      |
              +-------+-------+
              |               |
            READY           OFFLINE
```

`DISABLED` is an administrative state that removes a worker from routing without deleting it.

The Worker Manager owns each child process and captures PID, exit code, stderr tail, start time, last heartbeat, and failure count.

A worker becomes `DEGRADED` when its process exits unexpectedly, its MCP health probe fails, or a routed call returns a transport-level failure that indicates the worker is unusable.

The manager attempts one automatic restart for the current request. Repeated restart loops are prevented with a cooldown and failure counter.

## 6. Retry and Failover Semantics

Retries are conservative because Desktop Commander tools may mutate files or processes.

- Requests are retried automatically only when the failure is known to have occurred before the upstream worker accepted the MCP request.
- If execution acknowledgement is ambiguous, the router returns an error instead of replaying a potentially mutating operation.
- A successful worker restart does not imply replay unless the request is classified safe to retry.
- Failover updates the session binding only after the replacement worker is healthy.

## 7. Persistence Model

SQLite is the source of truth for durable routing metadata.

### `workers`

- `id TEXT PRIMARY KEY`
- `name TEXT NOT NULL`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `status TEXT NOT NULL`
- `pid INTEGER NULL`
- `failure_count INTEGER NOT NULL DEFAULT 0`
- `last_heartbeat_at TEXT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

### `sessions`

- `session_id TEXT PRIMARY KEY`
- `worker_id TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `last_used_at TEXT NOT NULL`
- foreign key to `workers(id)`

### `events`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `session_id TEXT NULL`
- `worker_id TEXT NULL`
- `type TEXT NOT NULL`
- `message TEXT NOT NULL`
- `metadata_json TEXT NULL`
- `created_at TEXT NOT NULL`

## 8. Windows Process Isolation

Each worker receives a dedicated runtime directory:

```text
data/
  workers/
    worker-1/
      home/
      logs/
      temp/
    worker-2/
      home/
      logs/
      temp/
```

The parent process spawns workers with isolated environment values for `USERPROFILE`, `HOME`, and `TEMP/TMP` pointing at the worker directory where appropriate.

The MVP does not promise OS-level security isolation between workers. The isolation goal is process/session separation and independent runtime state, not sandboxing against malicious code.

Worker stdout/stderr are captured independently and rotated by the manager. Worker processes are terminated when the manager shuts down cleanly.

## 9. Dashboard

A local React dashboard is served separately from the MCP endpoint.

The MVP exposes:

- worker status, PID, active-session count, failure count, and last heartbeat;
- enable/disable and restart actions;
- current session-to-worker bindings;
- recent event log with failover/restart reasons;
- manager health and uptime.

## 10. API Boundaries

The server has two logical surfaces:

### MCP surface

- accepts MCP client connections;
- extracts request metadata;
- delegates tool discovery and tool invocation to the selected worker;
- normalizes worker transport errors into MCP errors;
- never exposes worker-local process details to ChatGPT unless part of a tool result.

### Management surface

- `GET /api/health`
- `GET /api/workers`
- `POST /api/workers/:id/restart`
- `POST /api/workers/:id/enable`
- `POST /api/workers/:id/disable`
- `GET /api/sessions`
- `GET /api/events`

The management API binds to loopback by default. Remote exposure is not part of MVP.

## 11. Security and Safety

- Dashboard and management API listen on `127.0.0.1` by default.
- No passwords, OAuth tokens, or hosted-account credentials are stored by the MVP.
- Session ids are treated as opaque identifiers and are not used to infer identity.
- Logs redact environment secrets and authorization headers.
- Existing Desktop Commander filesystem/command restrictions remain authoritative at the worker layer.

## 12. Project Structure

```text
desktop-commander-manager/
  apps/
    server/
    dashboard/
  packages/
    router/
    worker-manager/
    mcp-proxy/
    database/
    shared/
  data/
  docs/superpowers/specs/
```

Responsibilities are intentionally split so routing logic can be tested without spawning real Desktop Commander processes, and worker lifecycle logic can be tested without an MCP client.

## 13. Technology Choices

- Runtime: Node.js 22+
- Language: TypeScript
- MCP: official Model Context Protocol TypeScript SDK
- HTTP/API: Fastify
- Persistence: SQLite
- Dashboard: React + Vite
- Tests: Vitest
- Package layout: npm workspaces

Tauri/system-tray packaging is deferred until the server and dashboard behavior are stable.

## 14. Test Strategy

Unit tests cover routing decisions, worker state transitions, retry classification, persistence, and event generation using fake workers.

Integration tests launch lightweight fake MCP workers and verify:

- two different sessions can be assigned to different workers;
- repeated calls from one session remain on its bound worker;
- bindings survive server restart;
- an unexpected worker exit triggers recovery;
- unrecoverable workers cause controlled rebinding;
- missing `openai/session` uses connection-scoped fallback behavior;
- no healthy worker returns a structured error;
- ambiguous mutating calls are not replayed automatically.

Dashboard tests verify management actions and status rendering against the management API.

A final Windows smoke test runs the real local Desktop Commander command and performs read-only filesystem/tool calls through the Router.

## 15. Acceptance Criteria

The MVP is accepted when:

1. ChatGPT can reach the manager as one MCP connector through Secure MCP Tunnel, while MCP Inspector can connect locally at `http://127.0.0.1:8787/mcp`.
2. The manager starts at least two local Desktop Commander workers.
3. Calls from the same ChatGPT conversation remain sticky to one worker.
4. New conversations are load-balanced among healthy workers.
5. Worker process failure is detected and recovered without manual process management.
6. A session is rebound only when its current worker cannot be recovered.
7. Session bindings survive manager restart.
8. Potentially mutating tool calls are never blindly duplicated during failure handling.
9. The local dashboard accurately shows workers, bindings, and recent events.
10. Automated tests pass on Windows with Node.js 22+.
