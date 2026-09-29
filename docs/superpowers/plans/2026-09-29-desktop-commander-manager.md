# Desktop Commander Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first MCP router that exposes one ChatGPT connector, keeps each ChatGPT conversation sticky to an isolated local Desktop Commander worker, and automatically recovers or fails over unhealthy workers.

**Architecture:** A Fastify/Streamable-HTTP MCP server receives requests, extracts `_meta["openai/session"]`, resolves a durable session binding, and forwards the call to a Desktop Commander stdio worker. Worker lifecycle, routing, SQLite persistence, management API, and dashboard are separate units so they can be tested independently.

**Tech Stack:** Node.js 22+, TypeScript, npm workspaces, `@modelcontextprotocol/sdk`, Fastify, SQLite, React + Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-desktop-commander-manager-design.md`

## Global Constraints

- Windows is the primary supported runtime for MVP.
- MCP endpoint: `http://127.0.0.1:8787/mcp`; management/dashboard binds to loopback only.
- Desktop Commander worker command: `npx -y @wonderwhy-er/desktop-commander@latest --no-onboarding`.
- Each worker gets isolated `USERPROFILE`, `HOME`, `TEMP`, and `TMP` directories.
- `_meta["openai/session"]` is opaque and is the sticky routing key when present.
- Missing session metadata uses a connection-scoped fallback id and logs `SESSION_KEY_MISSING`.
- Session bindings persist in SQLite across manager restarts.
- Never blindly replay a request when upstream execution acknowledgement is ambiguous.
- No hosted-account credential storage and no Remote MCP quota aggregation.

## Review Focus
- Missing/blank `openai/session`: connection-scoped fallback must stay sticky only for that connection and must not leak across clients. Covered in Task 4.
- Worker exits after receiving a mutating call: request must not be replayed automatically. Covered in Task 4.
- Manager restarts with stale worker PIDs in SQLite: workers must be reconciled to `STOPPED` before fresh startup. Covered in Task 2/3.
- Two workers tie on load/failures: selection must be deterministic round-robin, not always worker-1. Covered in Task 4.
- Management API receives restart/disable for unknown worker: return 404 and do not mutate persistence. Covered in Task 6.

---

## File Structure

- `package.json`, `tsconfig.base.json`, `vitest.config.ts`: workspace/build/test root.
- `packages/shared/src/types.ts`: shared worker/session/event/domain types.
- `packages/database/src/database.ts`: SQLite schema and repositories.
- `packages/worker-manager/src/worker-manager.ts`: process lifecycle and worker state.
- `packages/worker-manager/src/desktop-commander-process.ts`: stdio child-process adapter.
- `packages/router/src/session-router.ts`: durable binding and least-load routing.
- `packages/router/src/retry-policy.ts`: safe retry classification.
- `packages/mcp-proxy/src/worker-client.ts`: MCP client abstraction over worker stdio.
- `apps/server/src/mcp-server.ts`: Streamable HTTP MCP surface.
- `apps/server/src/management-api.ts`: local management endpoints.
- `apps/server/src/main.ts`: composition root/startup/shutdown.
- `apps/dashboard/src/*`: React management UI.

### Task 1: Workspace scaffold and shared domain contracts
**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/src/types.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/types.test.ts`

**Interfaces:**
- Produces: `WorkerStatus`, `WorkerRecord`, `SessionBinding`, `EventRecord`, `WorkerDescriptor`, `RouteContext`.

- [ ] **Step 1: Write shared contract tests** asserting allowed worker states and required session/event fields compile and serialize as expected.
- [ ] **Step 2: Run `npm test -- --run packages/shared/src/types.test.ts`** and verify it fails because the workspace/contracts do not exist.
- [ ] **Step 3: Create npm workspace configuration** for `apps/*` and `packages/*`, TypeScript strict mode, Vitest root config, and `.gitignore` entries for `node_modules`, `dist`, `data/*.db*`, worker runtime dirs, and logs.
- [ ] **Step 4: Implement shared contracts** with `WorkerStatus = 'STOPPED' | 'STARTING' | 'READY' | 'BUSY' | 'DEGRADED' | 'OFFLINE' | 'DISABLED'`; timestamps use ISO strings and ids use strings.
- [ ] **Step 5: Run `npm install` and the shared test**; expected PASS.
- [ ] **Step 6: Commit** with `chore: scaffold desktop commander manager workspace`.

### Task 2: SQLite persistence and startup reconciliation

**Files:**
- Create: `packages/database/package.json`
- Create: `packages/database/src/database.ts`, `packages/database/src/schema.ts`, `packages/database/src/index.ts`
- Test: `packages/database/src/database.test.ts`

**Interfaces:**
- Consumes: shared domain contracts from Task 1.
- Produces: `createDatabase(path: string): ManagerDatabase` where `ManagerDatabase` exposes `workers`, `sessions`, `events`, `close()` and `reconcileRuntimeState()`.
- Repository methods: `getWorker`, `listWorkers`, `upsertWorker`, `setWorkerState`, `getSession`, `upsertSession`, `listSessions`, `deleteSessionsForWorker`, `appendEvent`, `listEvents`.
- [ ] **Step 1: Write failing persistence tests** for schema creation, worker/session/event CRUD, durable session reload, and startup reconciliation changing persisted runtime states/PIDs to `STOPPED`/`NULL` without deleting enabled/disabled intent.
- [ ] **Step 2: Run `npm test -- --run packages/database/src/database.test.ts`**; expected FAIL because database package is absent.
- [ ] **Step 3: Implement SQLite schema** exactly matching spec tables `workers`, `sessions`, `events`, with foreign keys enabled and transactional session rebinding.
- [ ] **Step 4: Implement repositories and `reconcileRuntimeState()`**; stale `STARTING/READY/BUSY/DEGRADED/OFFLINE` rows become `STOPPED`, `pid` becomes null, `DISABLED` remains disabled.
- [ ] **Step 5: Re-run database tests**; expected PASS, including reopen of the same temporary DB file.
- [ ] **Step 6: Commit** with `feat: add manager persistence`.

### Task 3: Isolated Desktop Commander worker lifecycle

**Files:**
- Create: `packages/worker-manager/package.json`
- Create: `packages/worker-manager/src/desktop-commander-process.ts`
- Create: `packages/worker-manager/src/worker-manager.ts`, `packages/worker-manager/src/index.ts`
- Test: `packages/worker-manager/src/worker-manager.test.ts`

**Interfaces:**
- Consumes: `ManagerDatabase`, shared worker types.
- Produces: `DesktopCommanderProcessFactory.start(workerId, runtimeDir): Promise<WorkerProcessHandle>`.
- `WorkerProcessHandle`: `{ pid, stdin, stdout, stderr, exited, stop(): Promise<void> }`.
- Produces: `WorkerManager.startWorker(id)`, `stopWorker(id)`, `restartWorker(id)`, `enableWorker(id)`, `disableWorker(id)`, `getHealthyWorkers()`, `markBusy(id)`, `markReady(id)`.

- [ ] **Step 1: Write failing lifecycle tests** using a fake process factory for start → ready, unexpected exit → degraded/offline, restart, disable, and stale-PID recovery.
- [ ] **Step 2: Add an environment-isolation test** asserting worker-1 and worker-2 receive distinct absolute `USERPROFILE`, `HOME`, `TEMP`, `TMP` paths under `data/workers/<id>`.
- [ ] **Step 3: Run the worker-manager test**; expected FAIL because lifecycle code does not exist.
- [ ] **Step 4: Implement real process spawning** with `npx -y @wonderwhy-er/desktop-commander@latest --no-onboarding`, piped stdio, isolated env, independent log files, and graceful shutdown.
- [ ] **Step 5: Implement `WorkerManager` state transitions** and persist PID/status/failure counter/event records on start, exit, restart, enable, disable.
- [ ] **Step 6: Run worker-manager tests**; expected PASS.
- [ ] **Step 7: Commit** with `feat: manage isolated desktop commander workers`.

### Task 4: Session routing, retry policy, and failover

**Files:**
- Create: `packages/router/package.json`
- Create: `packages/router/src/session-router.ts`, `packages/router/src/retry-policy.ts`, `packages/router/src/index.ts`
- Test: `packages/router/src/session-router.test.ts`, `packages/router/src/retry-policy.test.ts`

**Interfaces:**
- Consumes: `ManagerDatabase`, `WorkerManager`.
- Produces: `SessionRouter.resolve(context: RouteContext): Promise<WorkerDescriptor>`.
- Produces: `SessionRouter.failover(sessionId: string, failedWorkerId: string): Promise<WorkerDescriptor>`.
- Produces: `createFallbackSessionId(connectionId: string): string`.
- Produces: `RetryPolicy.canReplay(failure: UpstreamFailure): boolean` where only explicit pre-dispatch transport failure returns true.

- [ ] **Step 1: Write failing routing tests** for existing sticky binding, least-session selection, failure-count tiebreak, deterministic round-robin tie, no-healthy-worker error, and binding persistence.
- [ ] **Step 2: Add fallback-session tests** proving missing/blank `openai/session` maps to one connection-scoped id and distinct connections never share it; assert `SESSION_KEY_MISSING` event creation.
- [ ] **Step 3: Write retry-policy tests** proving `PRE_DISPATCH` is replayable while `ACK_UNKNOWN`, `UPSTREAM_ERROR`, and `POST_DISPATCH` are not.
- [ ] **Step 4: Write failover tests** proving recoverable worker restart keeps binding, failed restart rebinds transactionally to a healthy worker, and ambiguous mutating calls are not replayed.
- [ ] **Step 5: Run router tests**; expected FAIL before implementation.
- [ ] **Step 6: Implement `SessionRouter`** using persisted bindings and eligible workers (`READY`/`BUSY`, enabled), selection order from spec, and transactionally update binding only after replacement health succeeds.
- [ ] **Step 7: Implement conservative `RetryPolicy`** with explicit failure classification; default to no replay for unknown failures.
- [ ] **Step 8: Re-run router tests**; expected PASS.
- [ ] **Step 9: Commit** with `feat: add sticky routing and failover policy`.

### Task 5: MCP worker client and Streamable HTTP proxy

**Files:**
- Create: `packages/mcp-proxy/package.json`
- Create: `packages/mcp-proxy/src/worker-client.ts`, `packages/mcp-proxy/src/index.ts`
- Create: `apps/server/package.json`, `apps/server/src/mcp-server.ts`
- Test: `packages/mcp-proxy/src/worker-client.test.ts`, `apps/server/src/mcp-server.test.ts`

**Interfaces:**
- Consumes: worker process handles, `SessionRouter`, `RetryPolicy`, `WorkerManager`.
- Produces: `WorkerClient.connect(handle): Promise<WorkerClient>` with `listTools()`, `callTool(name, args, meta)`, `close()`.
- Produces: `createMcpHttpServer(deps): Promise<{ close(): Promise<void> }>` exposing `POST/GET/DELETE /mcp` using MCP Streamable HTTP transport.

- [ ] **Step 1: Write fake-stdio MCP worker tests** proving tool discovery and a tool call round-trip through `WorkerClient`.
- [ ] **Step 2: Write MCP HTTP tests** verifying `/mcp` forwards tool discovery/calls, extracts `_meta["openai/session"]`, and uses one connection fallback id when metadata is absent.
- [ ] **Step 3: Add failure-path tests** for pre-dispatch transport failure retry, ambiguous dispatch failure returning an MCP error without replay, and no healthy worker returning structured MCP failure.
- [ ] **Step 4: Run MCP proxy/server tests**; expected FAIL before implementation.
- [ ] **Step 5: Implement stdio MCP clients** using the official TypeScript SDK and attach each client to the matching managed child process.
- [ ] **Step 6: Implement Streamable HTTP MCP server** on `127.0.0.1:8787/mcp`, delegating every routed call through `SessionRouter` and normalizing worker transport errors.
- [ ] **Step 7: Re-run MCP tests**; expected PASS.
- [ ] **Step 8: Commit** with `feat: proxy mcp calls to managed workers`.

### Task 6: Management API and composition root

**Files:**
- Create: `apps/server/src/management-api.ts`, `apps/server/src/main.ts`, `apps/server/src/config.ts`
- Test: `apps/server/src/management-api.test.ts`, `apps/server/src/main.test.ts`

**Interfaces:**
- Consumes: database, worker manager, MCP server.
- Produces management routes: `GET /api/health`, `GET /api/workers`, `POST /api/workers/:id/restart`, `POST /api/workers/:id/enable`, `POST /api/workers/:id/disable`, `GET /api/sessions`, `GET /api/events`.
- `startManager(config): Promise<ManagerRuntime>` where runtime exposes `close()` and starts two default workers `worker-1`, `worker-2` when no persisted worker rows exist.

- [ ] **Step 1: Write failing API tests** for all routes, localhost binding configuration, worker actions, event/session listing, and 404 for unknown worker ids.
- [ ] **Step 2: Write startup/shutdown tests** verifying database reconciliation runs before worker spawn, two defaults are seeded once, and shutdown stops workers then closes DB.
- [ ] **Step 3: Run server tests**; expected FAIL before implementation.
- [ ] **Step 4: Implement management API** on `127.0.0.1:8788` with JSON responses and no remote binding override in MVP.
- [ ] **Step 5: Implement composition root** that creates DB → reconciles runtime state → seeds workers → starts enabled workers → starts MCP/API surfaces; shutdown reverses ownership order.
- [ ] **Step 6: Run server tests**; expected PASS.
- [ ] **Step 7: Commit** with `feat: add local manager api and startup lifecycle`.

### Task 7: React dashboard
**Files:**
- Create: `apps/dashboard/package.json`, `apps/dashboard/index.html`, `apps/dashboard/vite.config.ts`
- Create: `apps/dashboard/src/main.tsx`, `apps/dashboard/src/App.tsx`, `apps/dashboard/src/api.ts`, `apps/dashboard/src/types.ts`, `apps/dashboard/src/styles.css`
- Test: `apps/dashboard/src/App.test.tsx`

**Interfaces:**
- Consumes management API from Task 6.
- Produces read/update UI for worker health/actions, session bindings, recent events, manager uptime.

- [ ] **Step 1: Write failing dashboard tests** with mocked API for worker cards, active-session counts, restart/enable/disable actions, sessions table, events table, and error state.
- [ ] **Step 2: Run dashboard test**; expected FAIL because dashboard does not exist.
- [ ] **Step 3: Implement API client** targeting same host port `8788`, with typed calls for Task 6 routes.
- [ ] **Step 4: Implement dashboard** as a compact operational UI: manager health summary, workers table/cards, sessions table, recent events; refresh every 5 seconds and immediately after management actions.
- [ ] **Step 5: Re-run dashboard tests and `npm run build -w apps/dashboard`**; expected PASS/build success.
- [ ] **Step 6: Commit** with `feat: add desktop commander manager dashboard`.

### Task 8: End-to-end integration, Windows smoke test, and operator docs

**Files:**
- Create: `tests/fakes/fake-mcp-worker.ts`
- Create: `tests/integration/router.integration.test.ts`
- Create: `scripts/smoke-windows.ps1`
- Create: `README.md`, `docs/secure-mcp-tunnel.md`
- Modify: root `package.json` scripts.

**Interfaces:**
- Consumes complete manager from Tasks 1-7.
- Produces root scripts `dev`, `test`, `test:integration`, `build`, `smoke:windows`.

- [ ] **Step 1: Write integration tests** launching two fake stdio workers and the real manager; assert two new sessions distribute across workers, each session remains sticky, and bindings survive manager restart.
- [ ] **Step 2: Add failure integration tests** forcing one fake worker to exit: verify one restart attempt, rebinding only after failed recovery, and no replay for ambiguous mutating calls.
- [ ] **Step 3: Run `npm run test:integration`**; expected FAIL before final wiring is complete.
- [ ] **Step 4: Add root scripts and final wiring** so `npm test`, `npm run test:integration`, `npm run build`, and `npm run dev` work from repository root.
- [ ] **Step 5: Write `scripts/smoke-windows.ps1`** to start the manager with two real Desktop Commander local workers, wait for `/api/health`, invoke only read-only MCP operations through the router, and always shut down spawned processes in `finally`.
- [ ] **Step 6: Write operator documentation** covering install, ports, data paths, dashboard, worker reset, local MCP Inspector usage, and Secure MCP Tunnel setup without storing credentials in the repo.
- [ ] **Step 7: Run full verification**: `npm test`, `npm run test:integration`, `npm run build`, then `npm run smoke:windows`; all must pass on Node.js 22+ Windows.
- [ ] **Step 8: Inspect `git status`** and confirm only intended source/docs plus lockfile changes remain; ensure `data/`, runtime homes, DBs, and logs are ignored.
- [ ] **Step 9: Commit** with `test: verify desktop commander manager end to end`.

## Completion Gate

Before claiming the MVP complete:

1. Run the complete verification commands from Task 8 and capture their exit status.
2. Confirm management endpoints listen only on `127.0.0.1`.
3. Confirm two real workers have distinct runtime environment directories.
4. Confirm one conversation remains sticky across multiple tool calls.
5. Kill its worker once and verify controlled restart/failover behavior in the event log.
6. Verify no retry occurs for an intentionally simulated ambiguous mutating call.
7. Confirm README instructions reproduce a clean local startup.

## Self-Review Clarifications

- Task 3 process start reaches `STARTING`, not `READY`; `READY` is set only after Task 5 successfully establishes an MCP stdio client/health handshake. Lifecycle tests must assert this boundary and explicit `markReady(id)` transition.
- Task 5 derives fallback `connectionId` from the Streamable HTTP transport session/connection context, never from remote address or user data.
- Task 6 serves management JSON under `/api/*` on `127.0.0.1:8788`; Task 7 production build is served by that same Fastify surface at `/`, while Vite development uses its own dev port and proxies `/api` to `8788`.
- Task 6 composition must connect each spawned worker with `WorkerClient` before calling `markReady`; a failed handshake leaves that worker `DEGRADED/OFFLINE` and ineligible for routing.
