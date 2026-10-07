# M4 Rust State and Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move SQLite persistence and sticky-session routing/failover ownership to Rust while Node continues to own public MCP HTTP ingress and the management HTTP API.

**Architecture:** Treat database + router as one `stateOwner` capability because routing mutates session bindings/events. Rust uses a schema-compatible SQLite repository and routes directly to the already Rust-owned worker runtime. Node public servers consume async state/proxy abstractions; when `stateOwner=rust`, Node never opens or writes the manager SQLite database.

**Tech Stack:** Rust, rusqlite, serde/serde_json, sha2, existing Rust worker runtime, TypeScript compatibility adapters, Vitest + Cargo tests.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-db-router` created from the latest passing `dev` after M2-M3 merges.
- `stateOwner=rust` requires `workerOwner=rust`; reject invalid mixed ownership at startup.
- Node remains owner of public MCP port 8787 and management port 8788.
- When `stateOwner=rust`, Node must not call `createDatabase` or write SQLite.
- Preserve the existing `workers`, `sessions`, and `events` table semantics so rollback to Node remains possible.
- Add explicit schema-version/migration metadata transactionally without destroying old data.
- Session fallback id remains `fallback:` + first 24 lowercase hex chars of SHA-256(connectionId).
- Worker selection remains least active sessions -> least failures -> deterministic round-robin tie break.
- Existing bound healthy worker remains sticky.
- Bound unhealthy worker is restarted first; rebind only after recovery fails and a replacement is healthy.
- Only `PRE_DISPATCH` calls may be replayed.
- Audit failures must not turn a successful tool call into a failed tool call.
- M4 promotion requires contract parity, validated Node rollback, and p95 manager routing overhead regression <= 5%.

## Review Focus

- Opening a legacy Node-created DB with no migration metadata must preserve every worker/session/event record.
- A migration interrupted halfway must roll back cleanly and leave Node able to reopen the database.
- Two simultaneous session binds for the same session id must converge to one durable binding without double events or corrupt active-session counts.
- Router restart/failover racing with an unexpected worker state event must never bind to a non-healthy worker.
- Audit metadata containing secrets must retain the current redaction behavior after the DB writer moves to Rust.

---

### Task 1: Add versioned, rollback-compatible Rust SQLite schema migration

**Files:**
- Create: `crates/manager-db/Cargo.toml`
- Create: `crates/manager-db/src/lib.rs`
- Create: `crates/manager-db/src/migrations.rs`
- Create: `crates/manager-db/src/models.rs`
- Create: `crates/manager-db/tests/migrations.rs`
- Modify: root `Cargo.toml`

**Interfaces:**
- Produces:
  - `ManagerDb::open(path: &Path) -> Result<ManagerDb, DbError>`
  - `ManagerDb::close(self) -> Result<(), DbError>`
  - migration tables `schema_version(version INTEGER NOT NULL)` and `migration_log(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`
- Legacy core table/column names remain compatible with `packages/database/src/schema.ts`.

- [ ] **Step 1: Write a legacy-schema migration fixture**

Create a SQLite database with exactly the current Node schema and representative workers/sessions/events but no migration metadata.

- [ ] **Step 2: Write migration tests**

Assert opening with Rust:
- preserves all fixture rows
- creates migration metadata transactionally
- enables foreign keys
- enables WAL mode unless the test environment reports a documented unsupported condition
- can be opened a second time without reapplying migrations

- [ ] **Step 3: Write interrupted-migration rollback test**

Inject a failing migration step inside a transaction. Assert no partial schema/data mutation survives.

- [ ] **Step 4: Implement `ManagerDb::open` and migration runner**

Keep the initial migration additive: do not rename/drop current core columns.

- [ ] **Step 5: Verify**

Run: `cargo test -p manager-db migrations`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/manager-db
git commit -m "feat: add rollback-compatible Rust database migrations"
```

### Task 2: Implement Rust repositories with Node-compatible semantics

**Files:**
- Create: `crates/manager-db/src/workers.rs`
- Create: `crates/manager-db/src/sessions.rs`
- Create: `crates/manager-db/src/events.rs`
- Create: `crates/manager-db/tests/repository.rs`
- Reference: `packages/database/src/database.ts`
- Reference: `packages/shared/src/types.ts`

**Interfaces:**
- Produces:
  - `WorkerRepository::{get, list, upsert, set_state}`
  - `SessionRepository::{get, list, upsert, rebind, delete_for_worker, count_by_worker}`
  - `EventRepository::{append, list}`
  - Rust model enums/structs matching `WorkerStatus`, `WorkerRecord`, `SessionBinding`, and `EventRecord`.

- [ ] **Step 1: Write repository behavior tests copied from Node semantics**

Cover persistence across reopen, reconcile stale runtime state, transactional rebind, session cleanup, event ordering/limit, and disabled intent preservation.

- [ ] **Step 2: Add atomic transition+event transaction helper**

Define `ManagerDb::with_transaction` and a focused helper used when a critical worker state transition and its event must commit together.

- [ ] **Step 3: Implement repositories with prepared statements**

Keep transactions short. Do not introduce event sourcing.

- [ ] **Step 4: Verify Node/Rust database compatibility**

Create data with Node -> read/mutate with Rust -> close Rust -> reopen with Node. Assert current Node APIs can read all resulting core data.

- [ ] **Step 5: Verify**

Run:
- `cargo test -p manager-db`
- `npx vitest run packages/database/src/database.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/manager-db
git commit -m "feat: implement Rust manager repositories"
```

### Task 3: Port sticky-session routing with behavior parity

**Files:**
- Create: `crates/manager-router/Cargo.toml`
- Create: `crates/manager-router/src/lib.rs`
- Create: `crates/manager-router/src/session_router.rs`
- Create: `crates/manager-router/src/retry_policy.rs`
- Create: `crates/manager-router/tests/session_router.rs`
- Modify: root `Cargo.toml`

**Interfaces:**
- Produces:
  - `create_fallback_session_id(connection_id: &str) -> String`
  - `SessionRouter::resolve(RouteContext) -> Result<WorkerDescriptor, RouteError>`
  - `SessionRouter::failover(session_id: &str, failed_worker_id: &str) -> Result<WorkerDescriptor, RouteError>`
  - `RetryPolicy::can_replay(UpstreamFailureKind) -> bool`
  - `RouteError::NoHealthyWorker`

- [ ] **Step 1: Port routing contract tests before implementation**

Replicate the six current TypeScript session-router scenarios:
- sticky persisted binding
- least sessions/failures/round-robin tie
- fallback session id + missing metadata event
- no healthy worker error
- same-worker recovery before failover
- rebind only after failed recovery

- [ ] **Step 2: Pin cross-language fallback hash parity**

Add a fixed connection id with the exact expected fallback id from the Node implementation.

- [ ] **Step 3: Implement retry policy**

Only `PRE_DISPATCH` returns true.

- [ ] **Step 4: Implement router against repository + worker-runtime traits**

Do not optimize algorithmic behavior during parity port.

- [ ] **Step 5: Add concurrent bind test**

Resolve the same new session concurrently. Assert one durable binding and consistent active-session counts.

- [ ] **Step 6: Add recovery-versus-worker-event race test**

Race route-time recovery of a degraded bound worker against an unexpected-exit/state update from the worker runtime. Assert the router never returns or persists a worker that is not healthy at the commit/selection point; if recovery loses the race, fail over only to a healthy replacement.

- [ ] **Step 7: Verify**

Run:
- `cargo test -p manager-router`
- `npx vitest run packages/router/src/session-router.test.ts packages/router/src/retry-policy.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml crates/manager-router
git commit -m "feat: port sticky session routing to Rust"
```

### Task 4: Add high-level Rust proxy operations

**Files:**
- Modify: `crates/manager-protocol/src/lib.rs`
- Modify: `apps/rust-manager/src/sidecar.rs`
- Create: `apps/rust-manager/src/backend.rs`
- Create: `apps/rust-manager/tests/backend_proxy.rs`

**Interfaces:**
- Add sidecar requests:
  - `BackendOpen { database_path, runtime_root }`
  - `BackendClose`
  - `ProxyListTools { context, meta }`
  - `ProxyCallTool { context, name, arguments, meta }`
  - `StateGetWorker { worker_id }`
  - `StateListWorkers`
  - `StateListSessions`
  - `StateListEvents { limit }`
  - `StateAppendEvent { event }`
- Proxy reply includes selected `worker_id`, `failed_over`, and raw MCP result/error classification.

- [ ] **Step 1: Write backend-open single-owner tests**

Opening the backend creates/opens the DB once and initializes default workers only when no workers exist.

- [ ] **Step 2: Write proxy routing tests**

Run list/call through Rust router + Rust worker runtime. Assert sticky routing and PRE_DISPATCH failover behavior.

- [ ] **Step 3: Implement `ManagerBackend` composition**

Own `ManagerDb`, `SessionRouter`, and references to the Rust WorkerSupervisor. Do not expose rusqlite types across crate boundaries.

- [ ] **Step 4: Add state-query/event append requests**

These support the still-Node management API and audit sink.

- [ ] **Step 5: Verify**

Run:
- `cargo test -p dcm-manager backend_proxy`
- `cargo test --workspace`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/manager-protocol apps/rust-manager
git commit -m "feat: expose Rust state and routing backend"
```

### Task 5: Refactor Node public servers onto async state/proxy interfaces

**Files:**
- Create: `apps/server/src/manager-state.ts`
- Create: `apps/server/src/node-manager-state.ts`
- Create: `apps/server/src/mcp-proxy-backend.ts`
- Create: `apps/server/src/node-mcp-proxy-backend.ts`
- Modify: `apps/server/src/management-api.ts`
- Modify: `apps/server/src/mcp-server.ts`
- Modify: `apps/server/src/main.ts`
- Modify tests for those files.

**Interfaces:**
- `ManagerStateProvider`:
  - `getWorker(id): Promise<WorkerRecord | undefined>`
  - `listWorkers(): Promise<WorkerDescriptor[]>`
  - `listSessions(): Promise<SessionBinding[]>`
  - `listEvents(limit: number): Promise<EventRecord[]>`
  - `appendEvent(event): Promise<EventRecord>`
- `McpProxyBackend`:
  - `listTools(context: RouteContext, meta?): Promise<{ workerId, result }>`
  - `callTool(context, name, args, meta?): Promise<{ workerId, failedOver, result }>`
- `ManagerRuntime` becomes ownership-neutral: `{ state: ManagerStateProvider; mcpUrl: string; managementUrl: string; close(): Promise<void> }`. Remove the public `database` field from this internal runtime interface and update tests to query `runtime.state` asynchronously.
- Node adapters wrap the existing database/router/worker runtime.

- [ ] **Step 1: Write interface-level tests against Node adapters**

The existing management/MCP tests must pass through these interfaces before Rust adapters are introduced.

- [ ] **Step 2: Refactor management API to await `ManagerStateProvider`**

Keep every route/status/JSON shape unchanged.

- [ ] **Step 3: Refactor MCP server to call `McpProxyBackend`**

Keep modern/legacy transport code, metadata sanitization, error normalization, argument summary redaction, and audit behavior in Node for now.

- [ ] **Step 4: Preserve audit as a state-provider command**

Successful/failed tool audit calls `appendEvent`; catch audit errors so they never fail the tool call.

- [ ] **Step 5: Verify**

Run:
- `npx vitest run apps/server/src/management-api.test.ts apps/server/src/mcp-server.test.ts apps/server/src/main.test.ts`
- `npm run test:contracts`
- `npm test`

Expected: PASS with `stateOwner=node`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "refactor: isolate manager state and proxy backends"
```

### Task 6: Add the Rust state/proxy adapters and ownership config

**Files:**
- Create: `apps/server/src/rust-manager-state.ts`
- Create: `apps/server/src/rust-manager-state.test.ts`
- Create: `apps/server/src/rust-mcp-proxy-backend.ts`
- Create: `apps/server/src/rust-mcp-proxy-backend.test.ts`
- Modify: `apps/server/src/native-sidecar.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/cli.ts`
- Modify: `apps/server/src/main.ts`
- Modify related tests.

**Interfaces:**
- Adds `stateOwner?: 'node' | 'rust'` and `DCM_STATE_OWNER`.
- Rust adapters implement Task 5 interfaces via sidecar.
- `stateOwner=rust` requires `workerOwner=rust`.

- [ ] **Step 1: Write config validation tests**

Reject:
- `stateOwner=rust, workerOwner=node`
- unknown owner values
- missing Rust sidecar path when Rust ownership is requested

- [ ] **Step 2: Implement Rust state adapter**

Map protocol JSON to existing TypeScript shared types without changing public API shapes.

- [ ] **Step 3: Implement Rust MCP proxy adapter**

Map Rust failure kinds back to `UpstreamCallError`/MCP normalization semantics.

- [ ] **Step 4: Make DB construction exclusive**

In `startManager`, do not call `createDatabase` at all for `stateOwner=rust`; open backend through the sidecar instead.

- [ ] **Step 5: Ensure runtime startup ordering is safe**

Rust worker/state ownership must be acquired before Node public ports are exposed. On failure, release resources and do not start a Node fallback owner.

- [ ] **Step 6: Verify**

Run:
- focused adapter/config/main tests
- `npm test`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src
git commit -m "feat: add Rust state and routing ownership"
```

### Task 7: Cross-language state/router compatibility and rollback suite

**Files:**
- Create: `tests/contracts/state-owner.contract.test.ts`
- Create: `tests/recovery/state-owner-rollback.test.ts`
- Modify: `tests/contracts/normalize.ts` to normalize any Rust/Node transport-only nondeterministic fields while preserving semantic state fields.

**Interfaces:**
- Consumes both `stateOwner=node` and `stateOwner=rust`.
- Produces identical external state/routing behavior.

- [ ] **Step 1: Run management-state contract scenarios under both owners**

Compare normalized workers/sessions/events/tool-call data.

- [ ] **Step 2: Run routing/MCP contract scenarios under both owners**

Assert sticky binding, recovery before failover, replay safety, fallback session hash, and audit fields/redaction.

- [ ] **Step 3: Test Node -> Rust -> Node database rollback**

Create and use DB with Node, stop Node ownership, use same DB under Rust, close Rust cleanly, reopen under Node, and assert all core data remains readable and correct.

- [ ] **Step 4: Test migration failure rollback**

Use a fixture/injected failing migration and prove Node can still reopen the untouched pre-migration DB.

- [ ] **Step 5: Verify**

Run:
- `npm run build:rust`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/contracts tests/recovery
git commit -m "test: verify Rust state ownership compatibility"
```

### Task 8: M4 performance and promotion gate

**Files:**
- Create: `docs/benchmarks/2026-10-07-m4-state-router.md`

**Interfaces:**
- Consumes M0/M2-M3 baselines.
- Produces state-owner promotion decision.

- [ ] **Step 1: Benchmark synthetic routing/tool dispatch**

Compare `stateOwner=node` vs `stateOwner=rust` with Rust worker ownership fixed in both cases where possible.

Gate:
- p95 manager routing overhead regression <= 5%
- p99 regression <= 10%

- [ ] **Step 2: Benchmark database-heavy operations**

Measure session resolve/rebind, event append/list, and management state queries to detect pathological SQLite serialization/locking.

- [ ] **Step 3: Stress concurrent session binding and worker failure**

Assert no corrupt bindings, no double writer, no deadlock, and no duplicate supervisor.

- [ ] **Step 4: Run full validation**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run lint:rust`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 5: Validate rollback and document it**

Rollback procedure:
1. stop manager/sidecar cleanly
2. set `DCM_STATE_OWNER=node`
3. restart
4. verify Node opens the same DB and routes existing sessions correctly

- [ ] **Step 6: Promote only if gates pass**

If pass, set the intended `dev` default to Rust state ownership while keeping the Node rollback path. If not, retain Node owner.

- [ ] **Step 7: Commit gate record**

```bash
git add docs/benchmarks/2026-10-07-m4-state-router.md
git commit -m "docs: record Rust state and router gate"
```

Then review and merge `feature/rust-db-router -> dev` only when all M4 gates pass.
