# M2-M3 Rust Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Desktop Commander worker process ownership, bounded recovery, and worker stdio MCP client ownership to Rust while Node remains authoritative for SQLite, session routing, management API, and public MCP ingress.

**Architecture:** Treat M2 supervisor + M3 stdio MCP client as one promotion unit. Rust never becomes the authoritative worker supervisor until it can also perform the MCP handshake and service `tools/list`/`tools/call`; this avoids forwarding raw worker stdio through the sidecar. Node talks to Rust through the existing private sidecar protocol and persists Rust-emitted lifecycle events into the existing SQLite model.

**Tech Stack:** Rust Cargo workspace from M1, Tokio for child/process/asynchronous IO, serde/serde_json, Windows ownership mutex through `manager-windows`, existing TypeScript router/database/API/MCP ingress.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-worker-supervisor` created from the latest passing `dev` after M1 merges.
- Keep `@wonderwhy-er/desktop-commander` as a Node worker; do not rewrite worker tools.
- Database/session/event authoritative writes remain Node-owned in this plan.
- Public ports 8787 and 8788 remain Node-owned.
- Rust worker ownership is disabled by default until the promotion gate passes.
- `workerOwner=node` must remain a tested rollback path.
- Do not allow Node `WorkerManager` and Rust `WorkerSupervisor` to supervise the same worker set concurrently.
- Use a no-admin per-user/session ownership primitive on Windows; do not require Windows Service installation.
- Rust must complete the worker MCP handshake before Node persists `READY`.
- Preserve `UpstreamFailureKind` semantics: only `PRE_DISPATCH` is replayable; `ACK_UNKNOWN` is never replayed.
- Use the bounded recovery schedule: immediate, 500 ms, 1 s, 2 s, 5 s; after exhaustion keep the worker degraded/offline.
- Promotion target: worker crash-to-READY median improves by at least 30%, p95 <= 5 seconds in the defined warm-worker test, and manager p95 dispatch overhead regresses by no more than 5%.
- No feature may depend on runtime `npx ...@latest`.

## Review Focus

- Worker exit racing with an explicit restart/disable must not produce duplicate restart loops or stale READY events.
- Sidecar loss after a tool request is written must classify the call as `ACK_UNKNOWN`, never `PRE_DISPATCH`.
- An ownership mutex abandoned by a crashed manager must be recoverable by the next manager without manual cleanup.
- Worker stdout may contain split/coalesced JSON lines; one malformed line must degrade that worker without corrupting other workers.
- A disabled worker must stay disabled across supervisor recovery, sidecar restart, and manager restart.

---

### Task 1: Pin and directly resolve the Desktop Commander worker executable

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/worker-manager/src/desktop-commander-process.ts`
- Modify: `packages/worker-manager/src/desktop-commander-process.test.ts`
- Create: `packages/worker-manager/src/desktop-commander-package.ts`
- Create: `packages/worker-manager/src/desktop-commander-package.test.ts`
- Modify: `docs/benchmarks/2026-10-07-node-baseline.md`

**Interfaces:**
- Produces: `resolveDesktopCommanderSpawnSpec(baseDir: string, env?: NodeJS.ProcessEnv): { command: string; args: string[] }`.
- The command must be the current Node executable and args must point at the locally installed package bin plus `--no-onboarding`.

- [ ] **Step 1: Resolve the currently validated package version**

Run: `npm view @wonderwhy-er/desktop-commander version`

Install that exact returned version into the workspace and commit the lockfile. Do not use a floating `latest` dependency.

- [ ] **Step 2: Write failing package-resolution tests**

Assert:
- the installed package.json/bin entry resolves to an absolute file
- spawn spec uses `process.execPath`
- args contain the resolved bin and `--no-onboarding`
- no arg contains `@latest`
- missing package/bin produces an actionable startup error

- [ ] **Step 3: Implement direct local package resolution**

Use Node module resolution/package metadata; do not hard-code a node_modules path.

- [ ] **Step 4: Keep legacy Node supervisor behavior but switch its spawn path**

Reuse `buildWorkerEnvironment`, logging, and stop semantics.

- [ ] **Step 5: Re-run the Node worker startup/recovery benchmark**

Because pinning removes runtime package resolution/network work, record a revised pinned-Node comparison baseline before measuring Rust ownership.

- [ ] **Step 6: Verify**

Run:
- `npx vitest run packages/worker-manager/src/desktop-commander-package.test.ts packages/worker-manager/src/desktop-commander-process.test.ts`
- `npm test`
- quick worker recovery benchmark

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json packages/worker-manager docs/benchmarks/2026-10-07-node-baseline.md
git commit -m "perf: pin Desktop Commander worker runtime"
```

### Task 2: Extend the sidecar protocol for worker runtime ownership

**Files:**
- Modify: `crates/manager-protocol/src/lib.rs`
- Modify: `crates/manager-protocol/tests/json_lines.rs`

**Interfaces:**
- Add requests:
  - `WorkerStart(WorkerStartRequest)`
  - `WorkerStop { worker_id: String }`
  - `WorkerRestart { worker_id: String }`
  - `WorkerListTools { worker_id: String, meta: Option<Value> }`
  - `WorkerCallTool { worker_id: String, name: String, arguments: Value, meta: Option<Value> }`
  - `WorkerShutdownAll`
- Add event envelope:
  - `SidecarMessage::Reply(SidecarReply)`
  - `SidecarMessage::Event(SidecarEvent)`
  - `SidecarEvent::WorkerStateChanged(WorkerStateEvent)`
- `WorkerStartRequest` includes `worker_id`, `runtime_dir`, `command`, `args`, and the environment overrides needed for isolated HOME/USERPROFILE/TEMP/TMP.
- `WorkerStateEvent` includes `worker_id`, state, pid, failure count delta/reason, and optional exit code/signal.
- Worker call failure result includes exact kind: `PRE_DISPATCH | ACK_UNKNOWN | UPSTREAM_ERROR | POST_DISPATCH`.

- [ ] **Step 1: Write protocol round-trip tests for every new request/event**

Pin serialized field names and failure-kind strings.

- [ ] **Step 2: Write async event/reply interleaving test data**

Ensure the protocol can carry an unsolicited worker event between two correlated replies.

- [ ] **Step 3: Implement protocol types only**

Do not add worker process logic yet.

- [ ] **Step 4: Verify**

Run: `cargo test -p manager-protocol`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/manager-protocol
git commit -m "feat: extend sidecar protocol for workers"
```

### Task 3: Add Rust worker state machine and ownership lock

**Files:**
- Create: `crates/manager-worker/Cargo.toml`
- Create: `crates/manager-worker/src/lib.rs`
- Create: `crates/manager-worker/src/state.rs`
- Create: `crates/manager-worker/src/ownership.rs`
- Create: `crates/manager-worker/tests/state_machine.rs`
- Modify: root `Cargo.toml`
- Modify: `crates/manager-windows/src/lib.rs`
- Create: `crates/manager-windows/src/ownership_mutex.rs`
- Create: `crates/manager-windows/tests/ownership_mutex.windows.rs`

**Interfaces:**
- Produces:
  - `enum WorkerState { Stopped, Starting, Ready, Busy, Degraded, Offline, Disabled }`
  - `WorkerStateMachine::transition(event: WorkerLifecycleEvent) -> Result<WorkerState, InvalidTransition>`
  - `trait SupervisorOwnershipGuard`
  - Windows mutex name: `Local\DesktopCommanderManager.WorkerSupervisor`

- [ ] **Step 1: Write state-transition tests**

Cover valid transitions from the design and reject invalid transitions such as `Disabled -> Ready` without enable/start.

- [ ] **Step 2: Implement the pure state machine**

No process spawning in this step.

- [ ] **Step 3: Write ownership mutex tests**

Launch two fixture processes. Assert the first acquires ownership, the second fails fast, and ownership can be reacquired after the first exits/crashes.

- [ ] **Step 4: Implement the no-admin Windows ownership mutex**

Use the `Local\` namespace. Add a portable trait boundary so non-Windows implementations can be supplied later.

- [ ] **Step 5: Verify**

Run:
- `cargo test -p manager-worker state_machine`
- `cargo test -p manager-windows ownership_mutex`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/manager-worker crates/manager-windows
git commit -m "feat: add worker state and ownership guard"
```

### Task 4: Implement the Rust stdio MCP worker client

**Files:**
- Create: `crates/manager-worker/src/mcp_client.rs`
- Create: `crates/manager-worker/src/json_lines.rs`
- Create: `crates/manager-worker/tests/mcp_client.rs`
- Reuse: `tests/fakes/fake-mcp-worker.ts`

**Interfaces:**
- Produces:
  - `WorkerMcpClient::connect(stdin, stdout) -> Result<WorkerMcpClient, WorkerCallError>`
  - `list_tools(&self, meta: Option<Value>) -> Result<Value, WorkerCallError>`
  - `call_tool(&self, name: &str, arguments: Value, meta: Option<Value>) -> Result<Value, WorkerCallError>`
  - `close(&self) -> Result<(), WorkerCallError>`
  - `WorkerCallError { kind: UpstreamFailureKind, message: String }`

- [ ] **Step 1: Write initialize/initialized handshake test**

Use the fake MCP worker fixture. Assert the client performs initialize and the initialized notification required by the worker protocol before reporting connected.

- [ ] **Step 2: Write `tools/list` and `tools/call` tests**

Assert arbitrary JSON result/_meta content survives the Rust round trip.

- [ ] **Step 3: Write framing tests**

Cover split lines, multiple messages in one read, blank lines, malformed JSON, and worker EOF.

- [ ] **Step 4: Write failure-classification tests**

Assert:
- failure before a request is written -> `PRE_DISPATCH`
- worker exits after the request is written but before response -> `ACK_UNKNOWN`
- JSON-RPC error response -> `UPSTREAM_ERROR`
- malformed post-dispatch response -> non-replayable `POST_DISPATCH` or `ACK_UNKNOWN` as pinned by the contract test

- [ ] **Step 5: Implement the minimal MCP stdio client**

Implement only initialize, initialized notification, `tools/list`, `tools/call`, and close. Do not build a general MCP SDK.

- [ ] **Step 6: Verify against the current real Desktop Commander worker**

Run a smoke handshake/list against the pinned local worker package in an isolated runtime directory.

Expected: handshake succeeds and tools are listed.

- [ ] **Step 7: Commit**

```bash
git add crates/manager-worker
git commit -m "feat: add Rust worker MCP stdio client"
```

### Task 5: Implement the Rust worker supervisor

**Files:**
- Create: `crates/manager-worker/src/supervisor.rs`
- Create: `crates/manager-worker/src/spawn.rs`
- Create: `crates/manager-worker/src/logging.rs`
- Create: `crates/manager-worker/tests/supervisor.rs`

**Interfaces:**
- Produces:
  - `WorkerSupervisor::new(ownership_guard, event_sink) -> WorkerSupervisor`
  - `start(WorkerStartSpec) -> Result<WorkerRuntimeInfo, WorkerSupervisorError>`
  - `stop(worker_id: &str) -> Result<(), WorkerSupervisorError>`
  - `restart(worker_id: &str) -> Result<WorkerRuntimeInfo, WorkerSupervisorError>`
  - `list_tools(...)`
  - `call_tool(...)`
  - `shutdown_all()`
- `WorkerRuntimeInfo { worker_id, pid, state }`.

- [ ] **Step 1: Write start/handshake/state-event tests**

Assert `Starting` event precedes `Ready`, and READY is emitted only after MCP handshake.

- [ ] **Step 2: Implement isolated runtime dirs and worker environment**

Create `home`, `temp`, `logs`; apply HOME/USERPROFILE/TEMP/TMP overrides supplied by the request.

- [ ] **Step 3: Implement stdout/stderr logging**

Preserve the existing behavior by appending worker protocol stdout to `logs/stdout.log` while parsing it, and stderr to `logs/stderr.log`.

- [ ] **Step 4: Write unexpected-exit recovery tests**

Assert delays are immediate, 500 ms, 1 s, 2 s, 5 s and stop after the configured bound. Use a fake clock/timer abstraction so unit tests do not sleep for real seconds.

- [ ] **Step 5: Implement bounded recovery with generation tokens**

Each start/restart increments a worker generation. Ignore exit/events from stale generations so explicit restart/disable cannot race with old process callbacks.

- [ ] **Step 6: Write disable/shutdown tests**

Assert intentional stop does not trigger recovery and shutdown leaves no fixture descendants.

- [ ] **Step 7: Verify**

Run:
- `cargo test -p manager-worker`
- Windows process-tree fixture tests

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/manager-worker
git commit -m "feat: supervise Desktop Commander workers in Rust"
```

### Task 6: Wire worker requests/events through the sidecar

**Files:**
- Modify: `apps/rust-manager/src/sidecar.rs`
- Modify: `apps/rust-manager/src/main.rs`
- Modify: `apps/rust-manager/tests/sidecar_protocol.rs`

**Interfaces:**
- Consumes: worker protocol requests from Task 2 and `WorkerSupervisor` from Task 5.
- Produces: correlated worker replies plus unsolicited `WorkerStateChanged` events.

- [ ] **Step 1: Write sidecar integration tests**

Start one fake worker through the sidecar, list/call a tool, kill it, observe state events/recovery, then stop it.

- [ ] **Step 2: Acquire supervisor ownership only when worker mode activates**

Platform-only M1 sidecar usage must not unnecessarily take the worker mutex.

- [ ] **Step 3: Implement worker dispatch and event writer serialization**

Use one stdout writer task/channel so replies and events cannot interleave at byte level.

- [ ] **Step 4: Verify**

Run:
- `cargo test -p dcm-manager`
- `cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/rust-manager
git commit -m "feat: expose Rust worker runtime through sidecar"
```

### Task 7: Introduce a Node worker-runtime abstraction

**Files:**
- Create: `apps/server/src/worker-runtime.ts`
- Create: `apps/server/src/node-worker-runtime.ts`
- Create: `apps/server/src/node-worker-runtime.test.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.test.ts`

**Interfaces:**
- Produces `WorkerRuntime`:
  - `getHealthyWorkers(): WorkerDescriptor[]`
  - `restartWorker(id: string): Promise<void>`
  - `enableWorker(id: string): Promise<void>`
  - `disableWorker(id: string): Promise<void>`
  - `getWorkerClient(id: string): ProxyWorkerClient`
  - `close(): Promise<void>`
- `createNodeWorkerRuntime(...)` wraps the existing `WorkerManager` + `WorkerClient` map.

- [ ] **Step 1: Write parity tests for the Node adapter**

Move no behavior yet; assert existing start/handshake/restart/disable semantics through `WorkerRuntime`.

- [ ] **Step 2: Implement `NodeWorkerRuntime` by extracting current composition from `main.ts`**

Do not change the default behavior.

- [ ] **Step 3: Refactor `startManager` to depend on `WorkerRuntime`**

Router and MCP server consume the same adapter interface regardless of owner.

- [ ] **Step 4: Verify**

Run:
- `npx vitest run apps/server/src/node-worker-runtime.test.ts apps/server/src/main.test.ts tests/integration/router.integration.test.ts`
- `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/worker-runtime.ts apps/server/src/node-worker-runtime.ts apps/server/src/node-worker-runtime.test.ts apps/server/src/main.ts apps/server/src/main.test.ts
git commit -m "refactor: isolate Node worker runtime"
```

### Task 8: Implement the Node adapter for Rust-owned workers

**Files:**
- Create: `apps/server/src/rust-worker-runtime.ts`
- Create: `apps/server/src/rust-worker-runtime.test.ts`
- Modify: `apps/server/src/native-sidecar.ts`
- Modify: `apps/server/src/native-sidecar.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/cli.ts`
- Modify: `apps/server/src/cli.test.ts`
- Modify: `apps/server/src/main.ts`

**Interfaces:**
- Adds `workerOwner?: 'node' | 'rust'` and env `DCM_WORKER_OWNER`.
- `RustWorkerRuntime` implements `WorkerRuntime`.
- Rust state events are persisted by Node using existing `ManagerDatabase`; Rust does not open SQLite.

- [ ] **Step 1: Extend NativeSidecarClient for events**

Add `onEvent(listener)` and worker request methods. Test an event arriving between replies.

- [ ] **Step 2: Write RustWorkerRuntime tests with a fake sidecar**

Assert state event -> existing DB state/event mappings for STARTING/READY/DEGRADED/DISABLED and that failure-count semantics match Node.

- [ ] **Step 3: Map Rust call failures to `UpstreamCallError`**

Pin every Rust failure kind to the existing TypeScript `UpstreamFailureKind`.

- [ ] **Step 4: Add ownership selection**

Default `workerOwner=node`. With `rust`, do not construct/start the Node WorkerManager for those workers.

- [ ] **Step 5: Add fail-fast conflict test**

If Rust cannot acquire supervisor ownership, manager startup must fail clearly; it must not silently fall back to Node while Rust may still own workers.

- [ ] **Step 6: Verify**

Run:
- `npx vitest run apps/server/src/rust-worker-runtime.test.ts apps/server/src/native-sidecar.test.ts apps/server/src/main.test.ts apps/server/src/cli.test.ts`
- `npm test`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src
git commit -m "feat: add Rust worker runtime ownership mode"
```

### Task 9: Run Node-vs-Rust worker-runtime contract tests

**Files:**
- Create: `tests/contracts/worker-runtime.contract.test.ts`
- Modify: `tests/recovery/node-manager-recovery.test.ts` to run its recovery scenarios through an owner-mode factory (`node` and `rust`).

**Interfaces:**
- Consumes: `NodeWorkerRuntime` and `RustWorkerRuntime`.
- Produces: one scenario suite run against both implementations.

- [ ] **Step 1: Parameterize contract scenarios**

Run identical scenarios:
- start -> READY
- list tools
- call tool
- restart
- unexpected exit recovery
- disable/enable
- manager shutdown
- handshake failure
- ambiguous mutation no-replay

- [ ] **Step 2: Add disabled-across-recovery scenario**

Disable a worker, restart the sidecar/manager fixture, and assert it remains disabled and unspawned.

- [ ] **Step 3: Add sidecar-crash scenario**

Kill the Rust sidecar while workers are owned by Rust. Assert Node marks runtime unavailable and does not start Node replacement workers until ownership is explicitly reconciled after restart.

- [ ] **Step 4: Verify**

Run:
- `npm run build:rust`
- `npx vitest run tests/contracts/worker-runtime.contract.test.ts`
- `npm test`

Expected: Node and Rust scenario outcomes match.

- [ ] **Step 5: Commit**

```bash
git add tests/contracts tests/recovery
git commit -m "test: verify worker runtime parity"
```

### Task 10: M2-M3 benchmark, rollback, and promotion gate

**Files:**
- Create: `docs/benchmarks/2026-10-07-m2-m3-worker-runtime.md`
- Modify: `docs/benchmarks/README.md` to document the pinned-worker recovery methodology and owner-mode comparison.

**Interfaces:**
- Consumes: pinned-Node baseline and Rust worker runtime.
- Produces: worker ownership promotion decision.

- [ ] **Step 1: Benchmark crash-to-READY recovery**

Use identical pinned package/runtime conditions for Node and Rust. Record raw samples, median, p95, and restart failures.

Gate: Rust median at least 30% faster and p95 <= 5 seconds.

- [ ] **Step 2: Benchmark manager dispatch overhead**

Run the M0 synthetic tool workload under `workerOwner=node` and `workerOwner=rust`.

Gate: p95 regression <= 5%; p99 regression <= 10%.

- [ ] **Step 3: Run ownership/recovery stress**

At minimum:
- 100 worker restart cycles
- repeated sidecar crash/restart
- concurrent explicit restart vs unexpected exit
- second-manager ownership attempt
- shutdown with active workers

Assert zero duplicate worker trees.

- [ ] **Step 4: Run full validation**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run lint:rust`
- `npm run test:rust`
- production Rust build/smoke

Expected: PASS.

- [ ] **Step 5: Validate rollback**

Run with `DCM_WORKER_OWNER=node` after a clean Rust shutdown/reconciliation and verify the legacy Node runtime owns workers normally. Rollback must be explicit; never auto-fallback mid-flight.

- [ ] **Step 6: Promote only on gate pass**

If gates pass, set the intended `dev` default to Rust worker ownership while preserving the Node flag for rollback. If any correctness/recovery gate fails, keep Node default.

- [ ] **Step 7: Commit the gate record**

```bash
git add docs/benchmarks
git commit -m "docs: record Rust worker runtime gate"
```

Then review and merge `feature/rust-worker-supervisor -> dev` only when all M2-M3 gates pass.
