# M1 Windows Platform Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the Rust workspace and a long-lived native sidecar that can inspect Windows process trees, sample resource usage, verify process identity, and terminate a process tree without spawning PowerShell/CIM/taskkill helper processes.

**Architecture:** Keep Node authoritative. Rust exposes a private newline-delimited JSON protocol over its own stdin/stdout. Node integrates the helper behind an explicit `node | rust | shadow` platform-ownership setting; shadow mode compares outputs but Node remains authoritative until the M1 benchmark/recovery gate passes.

**Tech Stack:** Stable Rust via rustup, Cargo workspace, serde/serde_json, thiserror, Windows APIs through the Rust `windows` crate, TypeScript Node child-process streams, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-platform` created from the latest passing `dev` after M0 merges.
- The current machine has no `rustc` or `cargo` in PATH; bootstrap the stable toolchain before coding and record the installed versions.
- Keep Node authoritative for database, routing, worker lifecycle, worker stdio, management API, and MCP ingress.
- Do not add an internal HTTP port.
- The sidecar protocol is private JSON Lines over stdio.
- Platform core types stay cross-platform; Windows API calls live in `manager-windows`.
- M1 resource sampling must not spawn `powershell.exe`, `Get-CimInstance`, or `taskkill.exe`.
- Default production ownership remains `node` until the M1 promotion gate passes.
- Shadow mode is read-only and cannot terminate processes.
- Preserve the existing `ResourceUsageSnapshot` API shape.
- Resource snapshot p95 must improve by at least 70% before promoting Rust sampling.
- Do not touch live worker processes in tests; use spawned fixture process trees.

## Review Focus

- Partial JSON lines, invalid UTF-8, and sidecar stdout contamination must produce a protocol error rather than desynchronize later replies.
- PID reuse must not be treated as process identity; identity includes PID plus process creation time and image path when accessible.
- Access-denied/system processes during enumeration must be skipped/diagnosed without failing the entire snapshot.
- Multiple `tunnel-client.exe` candidates must not be silently conflated; profile matching or an explicit unresolved diagnostic is required.
- Killing a process tree must verify the requested root identity and must never broaden the target because descendants changed during enumeration.

---

### Task 1: Bootstrap and pin the Rust workspace

**Files:**
- Create: `rust-toolchain.toml`
- Create: `Cargo.toml`
- Create: `apps/rust-manager/Cargo.toml`
- Create: `apps/rust-manager/src/main.rs`
- Create: `crates/manager-protocol/Cargo.toml`
- Create: `crates/manager-protocol/src/lib.rs`
- Create: `crates/manager-platform/Cargo.toml`
- Create: `crates/manager-platform/src/lib.rs`
- Create: `crates/manager-windows/Cargo.toml`
- Create: `crates/manager-windows/src/lib.rs`
- Modify: `package.json`

**Interfaces:**
- Consumes: stable Rust toolchain.
- Produces: a Cargo workspace containing `dcm-manager`, `manager-protocol`, `manager-platform`, and Windows-only `manager-windows`.

- [ ] **Step 1: Verify the expected precondition**

Run:
- `rustc --version`
- `cargo --version`

Expected on the current machine before bootstrap: command not found.

- [ ] **Step 2: Install rustup through the trusted Windows package path**

Preferred command: `winget install --id Rustlang.Rustup -e --source winget`

Then open/use a shell with `%USERPROFILE%\.cargo\bin` on PATH and run:
- `rustup default stable`
- `rustup component add rustfmt clippy`

If `winget` is unavailable or package installation fails, stop and report rather than downloading an unverified bootstrap binary.

- [ ] **Step 3: Record the toolchain and create `rust-toolchain.toml`**

Use channel `stable`, profile `minimal`, components `rustfmt` and `clippy`. Record `rustc --version` and `cargo --version` in the PR notes/benchmark metadata.

- [ ] **Step 4: Create the Cargo workspace**

Workspace members:
- `apps/rust-manager`
- `crates/manager-protocol`
- `crates/manager-platform`
- `crates/manager-windows`

Commit `Cargo.lock` because this repository builds an application.

- [ ] **Step 5: Add npm wrappers**

Add:
- `build:rust` -> `cargo build --workspace --release`
- `test:rust` -> `cargo test --workspace`
- `lint:rust` -> format check followed by clippy with warnings denied

- [ ] **Step 6: Verify workspace skeleton**

Run:
- `cargo fmt --check`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `cargo test --workspace`
- `npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add rust-toolchain.toml Cargo.toml Cargo.lock apps/rust-manager crates/manager-protocol crates/manager-platform crates/manager-windows package.json
git commit -m "build: add Rust manager workspace"
```

### Task 2: Define the private sidecar protocol before implementation

**Files:**
- Modify: `crates/manager-protocol/src/lib.rs`
- Create: `crates/manager-protocol/tests/json_lines.rs`

**Interfaces:**
- Produces:
  - `SidecarEnvelope { id: u64, request: SidecarRequest }`
  - `SidecarReply { id: u64, result: Option<SidecarResult>, error: Option<SidecarError> }`
  - `SidecarRequest::ProcessSnapshot(ProcessSnapshotRequest)`
  - `SidecarRequest::ProcessIdentity { pid: u32 }`
  - `SidecarRequest::KillProcessTree(KillProcessTreeRequest)`
  - `ProcessSnapshotRequest { manager_pid: u32, worker_pids: Vec<u32>, tunnel_profile: String }`
  - `ProcessUsage { root_pid: Option<u32>, memory_bytes: u64, cpu_seconds: f64, process_count: u32 }`
  - `ProcessIdentity { pid: u32, creation_time_100ns: u64, image_path: Option<String> }`

- [ ] **Step 1: Write serialization round-trip tests**

Pin the JSON tag names and camelCase/snake-case choice explicitly so the TypeScript client can rely on a stable wire format.

- [ ] **Step 2: Add malformed/unknown request tests**

Unknown method and malformed payload must deserialize to a structured protocol error at the app boundary, not panic.

- [ ] **Step 3: Implement only the protocol data types**

No Windows APIs or process logic in this task.

- [ ] **Step 4: Verify**

Run: `cargo test -p manager-protocol`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/manager-protocol
git commit -m "feat: define native sidecar protocol"
```

### Task 3: Define portable process-platform interfaces

**Files:**
- Modify: `crates/manager-platform/src/lib.rs`
- Create: `crates/manager-platform/tests/platform_contract.rs`

**Interfaces:**
- Consumes: protocol process request/result types.
- Produces:
  - `trait ProcessPlatform { fn snapshot(&self, request: &ProcessSnapshotRequest) -> Result<ProcessSnapshot, PlatformError>; fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, PlatformError>; fn kill_tree(&self, request: &KillProcessTreeRequest) -> Result<KillTreeResult, PlatformError>; }`
  - `ProcessSnapshot { manager: ProcessUsage, tunnel: ProcessUsage, workers: Vec<ProcessUsage>, diagnostics: Vec<String> }`
  - `KillProcessTreeRequest { pid: u32, expected_creation_time_100ns: Option<u64> }`

- [ ] **Step 1: Write trait-level fake implementation tests**

Verify callers can use a fake `ProcessPlatform` without any Windows dependency.

- [ ] **Step 2: Implement the trait/types**

Keep the crate free of `windows` imports and OS-specific cfg branches.

- [ ] **Step 3: Verify**

Run: `cargo test -p manager-platform`

Expected: PASS on any supported platform.

- [ ] **Step 4: Commit**

```bash
git add crates/manager-platform
git commit -m "feat: define portable process platform API"
```

### Task 4: Implement native Windows process inspection

**Files:**
- Modify: `crates/manager-windows/src/lib.rs`
- Create: `crates/manager-windows/src/process_table.rs`
- Create: `crates/manager-windows/src/process_metrics.rs`
- Create: `crates/manager-windows/src/process_identity.rs`
- Create: `crates/manager-windows/tests/process_snapshot.windows.rs`
- Create: `tests/fixtures/process-tree-parent.js`
- Create: `tests/fixtures/process-tree-child.js`

**Interfaces:**
- Implements: `manager_platform::ProcessPlatform`.
- Produces native Windows `snapshot`, `identity`, and process-table traversal.

- [ ] **Step 1: Write a Windows integration test that spawns a known process tree**

Spawn a fixture root with at least one child. Assert enumeration returns the root plus descendant count and nonzero memory.

- [ ] **Step 2: Write identity tests**

Assert:
- live fixture PID returns PID + nonzero creation time
- exited PID returns `None` or a structured not-found result
- image path is populated when permissions permit

- [ ] **Step 3: Implement process enumeration with Windows APIs**

Use Toolhelp/process APIs in-process. Handle access-denied per-process without failing the full table.

- [ ] **Step 4: Implement memory and cumulative CPU-time sampling**

Use process memory/time APIs; sum root + descendants. Do not shell out.

- [ ] **Step 5: Implement tunnel discovery**

Match `tunnel-client.exe` to the requested profile using an in-process command-line/identity mechanism. If matching cannot be proven, return no tunnel root plus a diagnostic rather than summing unrelated tunnel processes.

- [ ] **Step 6: Verify**

Run:
- `cargo test -p manager-windows`
- inspect Task Manager/process list while the test runs to confirm no PowerShell/CIM helper is spawned by the Rust sampler

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/manager-windows tests/fixtures
git commit -m "feat: sample Windows process trees natively"
```

### Task 5: Implement identity-checked native tree termination

**Files:**
- Create: `crates/manager-windows/src/process_kill.rs`
- Modify: `crates/manager-windows/src/lib.rs`
- Create: `crates/manager-windows/tests/process_kill.windows.rs`

**Interfaces:**
- Implements: `ProcessPlatform::kill_tree`.
- Consumes: root PID plus optional expected creation time.
- Produces: `KillTreeResult { root_pid: u32, terminated_pids: Vec<u32>, already_exited: bool }`.

- [ ] **Step 1: Write kill-tree fixture tests**

Assert all fixture descendants terminate and an unrelated sibling process survives.

- [ ] **Step 2: Write PID-identity mismatch test**

Pass a deliberately incorrect creation time. Assert the call refuses to terminate the root.

- [ ] **Step 3: Implement descendant collection + termination**

Snapshot descendants first, verify root identity, terminate descendants/root with native APIs, and return the affected PID set. Do not invoke `taskkill.exe`.

- [ ] **Step 4: Verify**

Run: `cargo test -p manager-windows process_kill`

Expected: PASS and no unrelated process termination.

- [ ] **Step 5: Commit**

```bash
git add crates/manager-windows
git commit -m "feat: terminate Windows process trees natively"
```

### Task 6: Add the Rust JSON-lines sidecar server

**Files:**
- Create: `apps/rust-manager/src/sidecar.rs`
- Modify: `apps/rust-manager/src/main.rs`
- Create: `apps/rust-manager/tests/sidecar_protocol.rs`

**Interfaces:**
- Consumes: one `SidecarEnvelope` per stdin line.
- Produces: exactly one matching `SidecarReply` per stdout line.
- Command: `dcm-manager sidecar`.

- [ ] **Step 1: Write protocol process tests**

Launch `dcm-manager sidecar`, send identity/snapshot requests, assert correlated response ids, and verify malformed JSON yields a structured error without exiting the process.

- [ ] **Step 2: Implement the line reader/dispatcher**

Keep logs off stdout; operational logs go to stderr.

- [ ] **Step 3: Add graceful EOF handling**

Closing stdin must shut down the sidecar cleanly.

- [ ] **Step 4: Verify**

Run:
- `cargo test -p dcm-manager`
- `cargo build --release -p dcm-manager`

Expected: PASS and a runnable `dcm-manager.exe sidecar`.

- [ ] **Step 5: Commit**

```bash
git add apps/rust-manager
git commit -m "feat: expose native platform sidecar"
```

### Task 7: Add the Node sidecar client and ownership configuration

**Files:**
- Create: `apps/server/src/native-sidecar.ts`
- Create: `apps/server/src/native-sidecar.test.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/cli.ts`

**Interfaces:**
- Produces:
  - `type CapabilityOwner = 'node' | 'rust' | 'shadow'`
  - `NativeSidecarClient.start(executablePath: string): Promise<NativeSidecarClient>`
  - `snapshot(request: ProcessSnapshotRequest): Promise<RawSnapshot>`
  - `identity(pid: number): Promise<ProcessIdentity | null>`
  - `killTree(request: KillProcessTreeRequest): Promise<KillTreeResult>`
  - `close(): Promise<void>`
- Config:
  - `platformOwner?: CapabilityOwner`
  - `nativeSidecarPath?: string`
- Environment:
  - `DCM_PLATFORM_OWNER`
  - `DCM_NATIVE_SIDECAR_PATH`

- [ ] **Step 1: Write client tests against a fake JSON-lines child**

Cover correlation ids, split/chunked lines, malformed response, child exit, request after close, and stderr not affecting protocol parsing.

- [ ] **Step 2: Implement the client**

Use one long-lived child; reject all pending requests if it exits.

- [ ] **Step 3: Add config/env parsing tests**

Invalid owner values must fail startup with an actionable message.

- [ ] **Step 4: Verify**

Run:
- `npx vitest run apps/server/src/native-sidecar.test.ts apps/server/src/cli.test.ts`
- `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/native-sidecar.ts apps/server/src/native-sidecar.test.ts apps/server/src/config.ts apps/server/src/cli.ts apps/server/src/cli.test.ts
git commit -m "feat: add native sidecar client"
```

### Task 8: Route resource monitoring through node/rust/shadow collectors

**Files:**
- Modify: `apps/server/src/resource-monitor.ts`
- Create: `apps/server/src/resource-monitor.test.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/main.test.ts`

**Interfaces:**
- Produces:
  - `interface ResourceCollector { collect(managerPid: number, workerPids: number[]): Promise<RawSnapshot> }`
  - `createPowerShellResourceCollector(): ResourceCollector`
  - `createNativeResourceCollector(client: NativeSidecarClient): ResourceCollector`
  - `createResourceMonitor(getWorkers, { owner, nodeCollector, rustCollector, onShadowComparison }): ResourceMonitor`

- [ ] **Step 1: Write collector-selection tests**

Assert:
- `node` calls only Node collector
- `rust` calls only Rust collector
- `shadow` returns Node result and also calls Rust
- shadow comparison failure cannot alter the authoritative response

- [ ] **Step 2: Refactor existing PowerShell logic behind `ResourceCollector`**

Do not change its current output behavior.

- [ ] **Step 3: Implement native collector adapter**

Map the Rust protocol result into the existing `RawSnapshot` shape.

- [ ] **Step 4: Wire startup/close lifecycle**

Start the sidecar only for `rust` or `shadow`; close it when manager closes. Default owner remains `node`.

- [ ] **Step 5: Verify**

Run:
- `npx vitest run apps/server/src/resource-monitor.test.ts apps/server/src/main.test.ts`
- `npm test`
- `npm run build`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/resource-monitor.ts apps/server/src/resource-monitor.test.ts apps/server/src/main.ts apps/server/src/main.test.ts
git commit -m "feat: add native resource monitor ownership modes"
```

### Task 9: Run shadow comparison and M1 promotion gate

**Files:**
- Create: `docs/benchmarks/2026-10-07-m1-native-platform.md`
- Modify: `docs/benchmarks/README.md` if methodology changes.

**Interfaces:**
- Consumes: M0 baseline and M1 node/rust/shadow collectors.
- Produces: promotion decision `node` or `rust` for platform metrics.

- [ ] **Step 1: Run correctness shadow sampling**

Run enough shadow snapshots across manager, tunnel, and two workers to compare:
- process counts exactly
- PID/root identity exactly where present
- memory within documented transient tolerance
- CPU deltas within documented sampling tolerance

Investigate every systematic mismatch.

- [ ] **Step 2: Run M1 performance benchmark**

Measure Node PowerShell collector vs Rust collector with identical roots/sample cadence.

Gate:
- Rust p95 snapshot latency improves by at least 70%
- Rust sampling spawns zero PowerShell/CIM/taskkill helper processes

- [ ] **Step 3: Run complete validation**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run lint:rust`
- `npm run test:rust`
- M1 benchmark command from the M0 harness

Expected: PASS.

- [ ] **Step 4: Document rollback**

Document that setting `DCM_PLATFORM_OWNER=node` and restarting returns resource sampling to the legacy collector without changing DB/worker ownership.

- [ ] **Step 5: Promote only if the gate passes**

If correctness and performance pass, change the intended `dev` default to `rust` in a small follow-up commit while retaining `node` rollback. If performance fails, keep `node` default and retain Rust behind the flag.

- [ ] **Step 6: Commit benchmark/promotion record**

```bash
git add docs/benchmarks
git commit -m "docs: record native platform benchmark gate"
```

Then review and merge `feature/rust-platform -> dev` only if the M1 gate is satisfied.
