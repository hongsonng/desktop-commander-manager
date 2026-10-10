# M5 Rust Management API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move management HTTP API and dashboard-static serving on port 8788 to Rust without changing any dashboard-facing route, status code, or JSON contract.

**Architecture:** Add an Axum-based `manager-api` crate backed directly by the Rust `ManagerBackend`, native resource sampler, and worker supervisor. Node still owns public MCP ingress on 8787, but when `managementApiOwner=rust` it does not create Fastify management API; instead it asks the Rust runtime to bind 8788 and returns that URL from the manager composition.

**Tech Stack:** Rust, Tokio, Axum, tower-http static serving, serde, existing manager-db/router/worker/platform crates, current React/Vite dashboard assets.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-management-api` created from the latest passing `dev` after M4 merges.
- `managementApiOwner=rust` requires `stateOwner=rust` and `workerOwner=rust`.
- Keep React/Vite dashboard source unchanged unless a contract test exposes an actual API incompatibility.
- Preserve every current `/api/*` route, HTTP status, JSON field name, filtering rule, action behavior, and dashboard-static path.
- Bind management API to loopback only.
- Preserve `mode: direct-local`, `workerStrategy: sticky-failover`, and the current MCP URL.
- Resource endpoint must use the native Rust platform sampler and preserve `ResourceUsageSnapshot` shape.
- Tool-call event parsing must preserve status, duration, argsSummary, failedOver, error, and current redaction semantics.
- Unknown worker actions return 404 without mutating worker state.
- Keep `managementApiOwner=node` as rollback until final cutover.
- No public MCP transport changes in this plan.

## Review Focus

- A missing/corrupt tool-call metadata JSON blob must degrade to the same safe defaults as Node instead of returning 500.
- Static asset paths containing encoded traversal sequences must not escape the dashboard directory.
- Port bind failure must abort the Rust API handoff cleanly; Node must not expose a half-started manager.
- Concurrent restart/enable/disable calls for one worker must serialize through the worker supervisor and preserve a valid final state.
- Resource-sampler failure must return the established unavailable snapshot shape rather than failing the whole endpoint.

---

### Task 1: Create the Rust management API crate and DTO contracts

**Files:**
- Create: `crates/manager-api/Cargo.toml`
- Create: `crates/manager-api/src/lib.rs`
- Create: `crates/manager-api/src/dto.rs`
- Create: `crates/manager-api/tests/dto.rs`
- Modify: root `Cargo.toml`

**Interfaces:**
- Produces DTOs matching current JSON:
  - health
  - connection info
  - worker + `activeSessionCount`
  - resources
  - session
  - event
  - tool call
  - API error
- DTO serialization uses the exact existing camelCase field names.

- [ ] **Step 1: Write serialization tests from the M0 contract fixtures**

Pin exact JSON key names and null/default behavior.

- [ ] **Step 2: Define DTO structs/enums**

Do not expose rusqlite/internal supervisor structs directly through HTTP serialization.

- [ ] **Step 3: Verify**

Run: `cargo test -p manager-api dto`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml crates/manager-api
git commit -m "feat: define Rust management API contracts"
```

### Task 2: Implement read-only management endpoints

**Files:**
- Create: `crates/manager-api/src/routes.rs`
- Create: `crates/manager-api/src/state.rs`
- Create: `crates/manager-api/tests/read_routes.rs`
- Reference: `apps/server/src/management-api.ts`

**Interfaces:**
- Produces `create_router(ApiState) -> axum::Router`.
- Read routes:
  - `GET /api/health`
  - `GET /api/connection`
  - `GET /api/workers`
  - `GET /api/resources`
  - `GET /api/sessions`
  - `GET /api/events`
  - `GET /api/tool-calls`

- [ ] **Step 1: Write route tests using an in-memory/temp backend**

Assert normalized outputs equal the M0 Node contract expectations.

- [ ] **Step 2: Implement health and connection routes**

Health returns `status=ok`, startedAt, and uptimeMs. Connection returns direct-local info supplied in `ApiState`.

- [ ] **Step 3: Implement workers/sessions/events**

Match Node ordering, limits, `TOOL_CALL` filtering, and active-session counts.

- [ ] **Step 4: Implement tool-call mapping**

Parse event metadata defensively; malformed JSON returns safe default fields exactly as Node does.

- [ ] **Step 5: Implement resources**

Call the Rust native sampler. On error return `available=false` plus manager/system fallback fields; do not return HTTP 500 for a sampling failure.

- [ ] **Step 6: Verify**

Run: `cargo test -p manager-api read_routes`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/manager-api
git commit -m "feat: serve Rust management state endpoints"
```

### Task 3: Implement worker mutation endpoints

**Files:**
- Create: `crates/manager-api/src/actions.rs`
- Create: `crates/manager-api/tests/actions.rs`
- Modify: `crates/manager-api/src/routes.rs`

**Interfaces:**
- Routes:
  - `POST /api/workers/:id/restart`
  - `POST /api/workers/:id/enable`
  - `POST /api/workers/:id/disable`
- Calls authoritative Rust backend/supervisor methods and returns the resulting worker record.

- [ ] **Step 1: Write success tests for all three actions**

Assert HTTP 200, action is executed once, and returned worker state matches persisted state.

- [ ] **Step 2: Write unknown-worker tests**

Assert HTTP 404 with the current error shape and zero supervisor calls.

- [ ] **Step 3: Write concurrent-action state-validity test**

Issue racing actions for one fixture worker and assert all mutations serialize through the supervisor/backend without duplicate process trees or impossible state.

- [ ] **Step 4: Implement handlers**

No direct process manipulation in route code; route -> backend action only.

- [ ] **Step 5: Verify**

Run: `cargo test -p manager-api actions`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/manager-api
git commit -m "feat: add Rust worker management actions"
```

### Task 4: Serve dashboard assets safely from Rust

**Files:**
- Create: `crates/manager-api/src/static_files.rs`
- Create: `crates/manager-api/tests/static_files.rs`
- Modify: `crates/manager-api/src/routes.rs`

**Interfaces:**
- Consumes: optional absolute dashboard dist directory.
- Produces static root/assets behavior equivalent to current Fastify static registration.

- [ ] **Step 1: Write static root/asset tests**

Create a temp dist containing `index.html` and one asset. Assert both are served with HTTP 200 and exact bytes.

- [ ] **Step 2: Write missing-dist behavior test**

When dashboard dir is absent/invalid, API routes continue to work and static requests are not falsely successful.

- [ ] **Step 3: Write traversal tests**

Encoded `..\` / `../` paths cannot escape the configured root.

- [ ] **Step 4: Implement static serving**

Use tower-http or an equivalent library-backed safe file service; do not hand-roll path joins from URL strings.

- [ ] **Step 5: Verify**

Run: `cargo test -p manager-api static_files`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/manager-api
git commit -m "feat: serve dashboard from Rust management API"
```

### Task 5: Add management-server lifecycle to the Rust manager process

**Files:**
- Modify: `crates/manager-protocol/src/lib.rs`
- Modify: `apps/rust-manager/src/backend.rs`
- Modify: `apps/rust-manager/src/sidecar.rs`
- Create: `apps/rust-manager/src/management_server.rs`
- Create: `apps/rust-manager/tests/management_server.rs`

**Interfaces:**
- Add requests:
  - `ManagementStart { host, port, dashboard_dir, mcp_url }`
  - `ManagementStop`
- Reply to start includes actual bound URL (important for port 0 tests).
- Only one management listener may exist per Rust process.

- [ ] **Step 1: Write lifecycle tests with port 0**

Start -> query health -> stop -> confirm listener closes.

- [ ] **Step 2: Write double-start and bind-failure tests**

Second start returns structured already-running error. Occupied port returns a structured bind error and leaves no partial listener state.

- [ ] **Step 3: Implement server task + graceful shutdown channel**

Keep lifecycle owned by Rust app composition, not route handlers.

- [ ] **Step 4: Verify**

Run:
- `cargo test -p dcm-manager management_server`
- `cargo test --workspace`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/manager-protocol apps/rust-manager
git commit -m "feat: manage Rust dashboard API listener"
```

### Task 6: Add Node ownership selection for management API

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/cli.ts`
- Modify: `apps/server/src/cli.test.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.test.ts`
- Modify: `apps/server/src/native-sidecar.ts`

**Interfaces:**
- Adds `managementApiOwner?: 'node' | 'rust'`.
- Adds env `DCM_MANAGEMENT_API_OWNER`.
- Rust owner requires `stateOwner=rust` and `workerOwner=rust`.

- [ ] **Step 1: Write ownership validation tests**

Reject invalid mixed modes. Default remains Node until promotion.

- [ ] **Step 2: Add sidecar client methods `startManagementApi` / `stopManagementApi`**

Return the actual URL from the Rust reply.

- [ ] **Step 3: Refactor `startManager` listener ownership**

If Node owner: call existing `createManagementApi`.
If Rust owner: never bind Fastify management API; request the Rust listener instead.

- [ ] **Step 4: Preserve close ordering**

Stop public listeners before tearing down backend/worker runtime. Ensure Rust management listener is closed exactly once.

- [ ] **Step 5: Verify**

Run:
- `npx vitest run apps/server/src/cli.test.ts apps/server/src/main.test.ts`
- `npm test`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "feat: add Rust management API ownership"
```

### Task 7: Run Node-vs-Rust management API contract parity

**Files:**
- Modify: `tests/contracts/management-api.contract.test.ts` to export/reuse the shared scenario definitions.
- Create: `tests/contracts/management-api-owner.contract.test.ts`
- Modify: `tests/contracts/normalize.ts` only to add explicit normalization required by the Rust HTTP implementation.

**Interfaces:**
- Runs the same normalized HTTP scenario set against Node-owned and Rust-owned API implementations.

- [ ] **Step 1: Parameterize the full M0 management contract**

Run all read routes, mutation routes, 404 behavior, resource-failure shape, and dashboard static behavior under both owners.

- [ ] **Step 2: Add malformed tool-call metadata scenario**

Insert one malformed `metadata_json`; compare Node and Rust safe-default response.

- [ ] **Step 3: Add static traversal scenario**

Assert both implementations reject paths escaping dashboard root.

- [ ] **Step 4: Verify against built Rust binary**

Run:
- `npm run build:rust`
- `npx vitest run tests/contracts/management-api-owner.contract.test.ts`
- `npm run test:contracts`

Expected: parity PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/contracts
git commit -m "test: verify Rust management API parity"
```

### Task 8: M5 benchmark, smoke, rollback, and promotion gate

**Files:**
- Create: `docs/benchmarks/2026-10-07-m5-management-api.md`

**Interfaces:**
- Consumes M0/M4 baselines.
- Produces management API ownership promotion decision and data for M6 stop-condition review.

- [ ] **Step 1: Benchmark management API latency and control-plane RSS**

Measure Node-owner vs Rust-owner requests for workers/sessions/events/resources and mutation smoke. Record p50/p95/p99 and combined Node+Rust RSS.

Large unexplained regressions must be investigated even though the design's hard latency gate applies to manager routing.

- [ ] **Step 2: Run production dashboard smoke**

Build dashboard, start Rust management API against `apps/dashboard/dist`, load root/assets, and exercise worker action endpoints.

- [ ] **Step 3: Run full validation**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run lint:rust`
- `npm run test:rust`
- production Rust build/smoke

Expected: PASS.

- [ ] **Step 4: Validate rollback**

Stop Rust management listener, set `DCM_MANAGEMENT_API_OWNER=node`, restart, and verify the Node API/dashboard reads the same Rust-owned state backend successfully.

- [ ] **Step 5: Promote only if correctness/recovery pass and complexity remains justified**

If pass, set intended `dev` default to Rust management API while preserving Node rollback. Record combined control-plane RSS/startup figures for M6.

- [ ] **Step 6: Commit gate record**

```bash
git add docs/benchmarks/2026-10-07-m5-management-api.md
git commit -m "docs: record Rust management API gate"
```

Then review and merge `feature/rust-management-api -> dev` only after the M5 gate passes.
