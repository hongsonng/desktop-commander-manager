# M7 Rust MCP Ingress and Standalone Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining Node manager control-plane process by porting the exact current MCP HTTP ingress behavior to Rust and composing all authoritative Rust subsystems into standalone dcm-manager.exe run.

**Architecture:** Implement the narrow MCP surface actually used by this project directly on Axum, driven by the M0 contract suite rather than by a broad rewrite of an MCP SDK. The Rust server delegates routing/tool execution to ManagerBackend. After contract parity, add a standalone composition root that owns platform, workers, SQLite/router, management API, and MCP listeners in one Rust process while Desktop Commander workers remain Node.

**Tech Stack:** Rust, Tokio, Axum, serde/serde_json, existing Rust manager crates, and the TypeScript M0 contract harness.

**Spec:** docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md

## Global Constraints

- Execute only if M6 decision is CONTINUE_M7.
- Work on feature/rust-mcp-ingress created from the latest passing dev.
- Preserve public MCP URL http://127.0.0.1:8787/mcp.
- Preserve server name desktop-commander-manager and current server-version behavior.
- Preserve modern protocol version 2026-07-28.
- Preserve legacy Streamable HTTP session behavior observed by the M0 contracts.
- Preserve openai/session routing metadata, modern envelope filtering, tool descriptor sanitization, error normalization, and replay safety.
- Only PRE_DISPATCH failures may be replayed/fail over.
- Tool-call audit failures must never fail an otherwise successful tool call.
- Do not rewrite Desktop Commander workers or Secure MCP Tunnel.
- Standalone Rust defaults must match the current Node CLI defaults: data/manager.db, data/workers, apps/dashboard/dist, MCP 8787, management 8788.
- Rollback to the Node compatibility host must remain possible with the same database.
- Final control-plane targets: RSS <= 60% of M0 Node baseline, startup >= 50% faster, p95 overhead regression <= 5%, p99 <= 10%.

## Review Focus

- Missing/stale legacy mcp-session-id must keep the current 400/404 semantics and never create phantom sessions.
- Modern envelope metadata must not leak unsupported transport metadata to workers.
- Unsupported UI/widget tool metadata must be removed without deleting unrelated metadata.
- Client disconnect during a tool call must never cause unsafe replay or duplicate audit.
- Graceful shutdown with active sessions must close listeners/sessions and workers exactly once.

---
### Task 1: Create the Rust MCP crate and shared JSON-RPC types

**Files:**
- Create: crates/manager-mcp/Cargo.toml
- Create: crates/manager-mcp/src/lib.rs
- Create: crates/manager-mcp/src/jsonrpc.rs
- Create: crates/manager-mcp/src/types.rs
- Create: crates/manager-mcp/tests/jsonrpc.rs
- Modify: root Cargo.toml

**Interfaces:**
- Produces JSON-RPC request/result/error envelopes sufficient for initialize, initialized notification, tools/list, tools/call, and server/discover.
- Error mapper preserves current internal, method-not-found, and invalid-params behavior.

- [ ] **Step 1: Write serialization tests from M0 fixtures**

Pin ids as string/number/null, JSON-RPC 2.0, result/error exclusivity, and method names.

- [ ] **Step 2: Define the minimal wire types**

Use serde_json::Value for extensible MCP payload fields rather than modeling unrelated protocol surface.

- [ ] **Step 3: Implement error envelope helpers**

Pin exact numeric codes/messages required by existing contract tests.

- [ ] **Step 4: Verify**

Run: cargo test -p manager-mcp jsonrpc

Expected: PASS.

- [ ] **Step 5: Commit**

git add Cargo.toml crates/manager-mcp
git commit -m "feat: define Rust MCP ingress wire types"

### Task 2: Port tool metadata filtering and descriptor sanitization

**Files:**
- Create: crates/manager-mcp/src/metadata.rs
- Create: crates/manager-mcp/src/sanitize.rs
- Create: crates/manager-mcp/tests/metadata.rs
- Reference: apps/server/src/mcp-server.ts

**Interfaces:**
- Produces session_from_meta, worker_meta, sanitize_tool_descriptor, and modern server-info metadata helper.

- [ ] **Step 1: Write exact filtering tests**

Remove downstream modern envelope keys:
- io.modelcontextprotocol/protocolVersion
- io.modelcontextprotocol/clientInfo
- io.modelcontextprotocol/clientCapabilities

Keep openai/session routing interpretation consistent with Node.

- [ ] **Step 2: Write exact tool-sanitization tests**

Remove unsupported proxy meta:
- ui/resourceUri
- openai/outputTemplate
- openai/widgetAccessible
- ui

Preserve unrelated meta and derive top-level title from current title/annotations behavior.

- [ ] **Step 3: Implement pure helpers**

No HTTP/backend logic in these modules.

- [ ] **Step 4: Verify**

Run: cargo test -p manager-mcp metadata

Expected: PASS.

- [ ] **Step 5: Commit**

git add crates/manager-mcp
git commit -m "feat: port MCP metadata compatibility rules"
### Task 3: Implement modern protocol request handling

**Files:**
- Create: crates/manager-mcp/src/modern.rs
- Create: crates/manager-mcp/tests/modern.rs

**Interfaces:**
- Consumes ManagerBackend.
- Handles server/discover, tools/list, and tools/call.
- Modern version constant: 2026-07-28.

- [ ] **Step 1: Write server/discover tests**

Assert supportedVersions, capabilities.tools, resultType=complete, ttlMs=0, cacheScope=private, and serverInfo metadata.

- [ ] **Step 2: Write tools/list tests**

Assert routing metadata extraction, descriptor sanitization, modern result metadata, and complete/private cache fields.

- [ ] **Step 3: Write tools/call tests**

Assert args validation, backend delegation, raw result preservation, and serverInfo metadata merge.

- [ ] **Step 4: Write error tests**

Unknown method -> method-not-found response. Missing/empty tool name -> invalid params. Backend no-healthy-worker -> normalized MCP error.

- [ ] **Step 5: Implement modern handler**

Generate a connection id per modern request exactly as required for fallback session routing.

- [ ] **Step 6: Verify**

Run: cargo test -p manager-mcp modern

Expected: PASS.

- [ ] **Step 7: Commit**

git add crates/manager-mcp
git commit -m "feat: serve modern MCP requests in Rust"

### Task 4: Implement legacy Streamable HTTP session handling

**Files:**
- Create: crates/manager-mcp/src/legacy.rs
- Create: crates/manager-mcp/src/sessions.rs
- Create: crates/manager-mcp/tests/legacy.rs

**Interfaces:**
- Maintains in-memory legacy transport sessions keyed by mcp-session-id.
- Handles GET, POST, and DELETE on /mcp according to M0 contract behavior.

- [ ] **Step 1: Write initialize/session-id contract tests**

No incoming session + initialize creates a session. Subsequent calls with the returned session id reuse it.

- [ ] **Step 2: Write invalid session tests**

Pin unknown incoming session -> current Node 404 and non-initialize request with no session -> current Node 400.

- [ ] **Step 3: Write list/call routing tests**

Preserve openai/session, fallback connection id behavior, list sanitization, and tool result/error mapping.

- [ ] **Step 4: Write close/delete tests**

Session delete/close removes runtime state and later reuse returns unknown-session behavior.

- [ ] **Step 5: Implement session registry and handlers**

Use UUID session ids. Keep all state local to the MCP server.

- [ ] **Step 6: Verify**

Run: cargo test -p manager-mcp legacy

Expected: PASS.

- [ ] **Step 7: Commit**

git add crates/manager-mcp
git commit -m "feat: serve legacy MCP sessions in Rust"
### Task 5: Implement MCP HTTP listener lifecycle

**Files:**
- Create: crates/manager-mcp/src/server.rs
- Create: crates/manager-mcp/tests/server.rs
- Modify: crates/manager-mcp/src/lib.rs

**Interfaces:**
- Produces McpServer::start(config, backend) -> Result<McpServerHandle, McpServerError>.
- Handle exposes url() and shutdown().
- Route is /mcp and binds loopback only.

- [ ] **Step 1: Write port-0 lifecycle test**

Start -> initialize/list/call -> shutdown -> verify port closes.

- [ ] **Step 2: Write modern-vs-legacy dispatch test**

Modern request detection follows the body/header metadata rules from Node.

- [ ] **Step 3: Write bind-failure test**

Occupied port returns structured startup error and no partial runtime.

- [ ] **Step 4: Implement Axum listener/router**

Keep transport detection at the HTTP boundary; backend remains transport-agnostic.

- [ ] **Step 5: Verify**

Run: cargo test -p manager-mcp server

Expected: PASS.

- [ ] **Step 6: Commit**

git add crates/manager-mcp
git commit -m "feat: expose Rust MCP HTTP listener"

### Task 6: Run cross-language MCP contract parity before standalone cutover

**Files:**
- Modify: crates/manager-protocol/src/lib.rs
- Modify: apps/rust-manager/src/sidecar.rs
- Modify: apps/server/src/native-sidecar.ts
- Create: tests/contracts/mcp-owner.contract.test.ts
- Modify: tests/contracts/mcp.contract.test.ts only to share scenarios.

**Interfaces:**
- Add transitional sidecar requests McpStart { host, port } and McpStop so the TypeScript contract harness can start the Rust MCP listener against the existing Rust backend.

- [ ] **Step 1: Add start/stop protocol and lifecycle tests**

Port 0 must return the actual Rust MCP URL.

- [ ] **Step 2: Parameterize every M0 MCP contract scenario**

Run the same scenario set against Node createMcpHttpServer and Rust McpServer.

- [ ] **Step 3: Add raw HTTP edge scenarios**

Cover malformed body, missing ids where relevant, stale sessions, method not found, and modern header/body detection.

- [ ] **Step 4: Add disconnect-after-dispatch replay-safety scenario**

Have the backend record one mutating dispatch, then disconnect the HTTP client before the response completes. Assert the server does not issue a second backend call and emits at most one audit record for that dispatch.

- [ ] **Step 5: Verify**

Run:
- npm run build:rust
- npx vitest run tests/contracts/mcp-owner.contract.test.ts
- npm run test:contracts
- cargo test -p manager-mcp

Expected: parity PASS.

- [ ] **Step 6: Commit**

git add crates/manager-protocol apps/rust-manager apps/server/src/native-sidecar.ts tests/contracts
git commit -m "test: verify Rust MCP ingress parity"
### Task 7: Add standalone Rust manager configuration and composition root

**Files:**
- Create: `crates/manager-core/Cargo.toml`
- Create: `crates/manager-core/src/lib.rs`
- Create: `crates/manager-core/src/runtime.rs`
- Create: `crates/manager-core/tests/runtime_smoke.rs`
- Modify: root `Cargo.toml`
- Create: `apps/rust-manager/src/config.rs`
- Create: `apps/rust-manager/tests/config.rs`
- Modify: `apps/rust-manager/src/main.rs`

**Interfaces:**
- `manager_core::ManagerRuntime::start(config) -> Result<ManagerRuntime, ManagerRuntimeError>` composes platform, workers, state/router, management API, and MCP; the app crate owns only CLI/config translation.
- Command: dcm-manager run [--root <path>].
- Default root: current working directory.
- Default paths/ports:
  - <root>/data/manager.db
  - <root>/data/workers
  - <root>/apps/dashboard/dist
  - MCP 8787
  - management 8788
- Runtime owns one platform implementation, worker supervisor, ManagerBackend, management API, and MCP server.

- [ ] **Step 1: Write default-config parity test**

For a fixed root, assert Rust default paths/ports exactly equal createDefaultManagerConfig semantics.

- [ ] **Step 2: Write startup ordering test**

Acquire ownership -> open/migrate DB -> reconcile runtime -> start enabled workers/handshake -> start management API/MCP listeners. No public listener may report ready before authoritative state is initialized.

- [ ] **Step 3: Write crash/reboot reconciliation tests**

Cover a stale persisted PID, a reused PID whose creation time/image does not match the managed worker identity, an orphaned managed worker tree from a prior crashed manager, and a DISABLED worker with stale PID metadata. Assert only proven managed orphan trees are terminated, stale PID metadata is cleared, and disabled workers are not restarted.

- [ ] **Step 4: Implement runtime composition and reconciliation in `manager-core`**

Do not reuse the sidecar stdin/stdout protocol internally; call crate APIs directly. Keep CLI parsing/path translation in `apps/rust-manager` and orchestration/lifecycle in `crates/manager-core`. Verify process identity before acting on persisted PIDs.

- [ ] **Step 5: Implement graceful shutdown**

On Ctrl-C/SIGTERM:
1. stop accepting public requests
2. close MCP sessions/listener
3. close management listener
4. stop worker supervisor
5. close database/platform resources
6. release ownership guard

- [ ] **Step 6: Preserve CLI output**

Print:
- Desktop Commander Manager MCP: <url>
- Desktop Commander Manager UI:  <url>

- [ ] **Step 7: Verify isolated runtime smoke**

Use temp root/ports and a fixture worker command. Assert both health endpoints and tool proxy work, then clean shutdown leaves no child tree.

- [ ] **Step 8: Commit**

git add Cargo.toml crates/manager-core apps/rust-manager
git commit -m "feat: run the manager as a standalone Rust process"

### Task 8: Add build/package entry points for the standalone manager

**Files:**
- Modify: package.json
- Create: scripts/build-rust-manager.ps1
- Modify: `docs/benchmarks/README.md` to document standalone-manager benchmark and staged-artifact smoke commands.
- Keep legacy Node scripts for rollback until M8/final cutover.

**Interfaces:**
- Add npm scripts dev:rust, build:manager, and smoke:rust-manager.
- Production output includes dist/dcm-manager.exe and dashboard assets.

- [ ] **Step 1: Add build-script validation**

The build script must fail on a missing release binary/dashboard build and copy only expected artifacts.

- [ ] **Step 2: Implement build pipeline**

Build dashboard, build Rust release binary, and stage output under dist.

- [ ] **Step 3: Run from staged artifact**

Launch the staged executable with an isolated root/config, verify MCP/API health and one tool call, then shut down.

- [ ] **Step 4: Commit**

git add package.json scripts/build-rust-manager.ps1 docs
git commit -m "build: package standalone Rust manager"

### Task 9: M7 final performance/recovery/rollback gate

**Files:**
- Create: docs/benchmarks/2026-10-07-m7-standalone-manager.md

**Interfaces:**
- Compares M0 Node manager vs standalone Rust control plane.
- Produces M7 promotion decision.

- [ ] **Step 1: Run full cold-start benchmark**

Hard gate: process start -> health-ready at least 50% faster than M0 Node baseline.

- [ ] **Step 2: Run manager RSS benchmark**

Measure standalone Rust manager only, excluding Desktop Commander workers and tunnel.

Hard gate: RSS <= 60% of M0 Node manager RSS.

- [ ] **Step 3: Run MCP overhead benchmark**

Hard gates:
- p95 <= Node baseline * 1.05
- p99 <= Node baseline * 1.10

- [ ] **Step 4: Run recovery suite**

Worker crash, manager crash/restart, stale PID reconciliation, duplicate-manager attempt, DB migration/reopen, active-session shutdown, and ambiguous mutation no-replay must pass.

- [ ] **Step 5: Validate rollback to Node compatibility host**

Stop standalone Rust manager cleanly; start Node owner configuration on the same DB/runtime root; verify existing data and routing compatibility.

- [ ] **Step 6: Run full project validation**

Run:
- npm test
- npm run test:contracts
- npm run test:recovery
- npm run build
- npm run lint:rust
- npm run test:rust
- npm run build:manager
- npm run smoke:rust-manager

Expected: PASS.

- [ ] **Step 7: Document and commit gate**

git add docs/benchmarks/2026-10-07-m7-standalone-manager.md
git commit -m "docs: record standalone Rust manager gate"

Review and merge feature/rust-mcp-ingress -> dev only if all hard M7 gates pass. M8 may start only after this promotion.
