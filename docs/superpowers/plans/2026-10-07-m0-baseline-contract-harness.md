# M0 Baseline and Contract Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the current Node manager's external behavior and collect reproducible performance/recovery baselines before any Rust subsystem takes ownership.

**Architecture:** Add deterministic contract fixtures around the management API, MCP ingress, routing, and recovery behavior, plus a benchmark harness that runs the Node manager in isolated temp directories and ephemeral ports. Benchmark code stays outside production paths and emits machine-readable JSON plus a committed human-readable baseline summary.

**Tech Stack:** TypeScript 5.9, Vitest 5, Node.js 22 APIs, existing MCP SDK, PowerShell only for the existing Windows baseline/reboot harness.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-baseline` created from the latest passing `dev`.
- Do not change production routing, worker, database, MCP, API, or autostart semantics in M0.
- Use temp databases/runtime roots and ephemeral ports; never benchmark against the user's live manager database.
- Preserve the current external MCP/API/CLI behavior exactly.
- Record Node baseline before enabling any Rust code path.
- Default baseline counts are 50 cold starts, 500 `tools/list`, 1000 synthetic/no-op tool calls, 100 worker restart cycles, 20 manager crash/recovery cycles, and 10 controlled reboot/login observations.
- Benchmark results must record machine/runtime metadata and raw sample counts.
- Keep generated raw result files out of Git; commit methodology and the approved baseline summary.
- Merge `feature/rust-baseline -> dev` only after the existing suite, new contract suite, and benchmark harness tests pass.

## Review Focus

- Timing noise or thermal/background-process spikes must not let one outlier define the baseline; the harness must retain raw samples and report median/p95/p99.
- Ephemeral port allocation must prevent parallel tests from colliding with live ports 8787/8788.
- UUIDs, timestamps, PIDs, and dynamic ports must be normalized before Node/Rust contract comparisons.
- Tool-call overhead benchmarks must use a synthetic fast worker so worker execution time does not dominate manager overhead.
- Crash/recovery and reboot scripts must target only fixture processes/runtime roots and must refuse to operate when fixture identity cannot be verified.

---

### Task 1: Add deterministic benchmark statistics primitives

**Files:**
- Create: `tests/benchmarks/metrics.ts`
- Create: `tests/benchmarks/metrics.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: plain numeric duration/RSS samples.
- Produces: `percentile(samples: number[], percentile: number): number`, `summarize(samples: number[]): BenchmarkSummary`, and `BenchmarkSummary = { count, min, median, p95, p99, max, mean }`.

- [ ] **Step 1: Write failing unit tests for percentile and summary behavior**

Add tests named:
- `returns deterministic nearest-rank percentiles for sorted and unsorted samples`
- `summarizes empty input as an explicit error`
- `reports count/min/median/p95/p99/max/mean`

Assertions must pin exact results for a fixed sample array and verify the input array is not mutated.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run tests/benchmarks/metrics.test.ts`

Expected: FAIL because `tests/benchmarks/metrics.ts` does not exist.

- [ ] **Step 3: Implement the metrics functions**

Implement only the exported types/functions above. Keep percentile math deterministic and dependency-free.

- [ ] **Step 4: Add benchmark npm entry points**

Add scripts:
- `benchmark:node` -> run the Node baseline driver.
- `test:contracts` -> run `tests/contracts`.
- `test:recovery` -> run `tests/recovery`.

Do not change existing script meanings.

- [ ] **Step 5: Verify**

Run:
- `npx vitest run tests/benchmarks/metrics.test.ts`
- `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/benchmarks/metrics.ts tests/benchmarks/metrics.test.ts
git commit -m "test: add benchmark statistics primitives"
```

### Task 2: Freeze management API contracts

**Files:**
- Create: `tests/contracts/normalize.ts`
- Create: `tests/contracts/management-api.contract.test.ts`
- Reference: `apps/server/src/management-api.ts`
- Reference: `apps/server/src/management-api.test.ts`

**Interfaces:**
- Consumes: JSON returned by the existing management API.
- Produces: `normalizeContractValue(value: unknown): unknown` for deterministic contract comparison.

- [ ] **Step 1: Write failing normalization tests**

Cover timestamps, PIDs, loopback ephemeral ports, and stable ordinary values. The normalizer must not erase semantic fields such as worker status, worker id, session id, failure count, or API error codes.

- [ ] **Step 2: Implement `normalizeContractValue`**

Normalize only explicitly nondeterministic values. Keep the function pure.

- [ ] **Step 3: Write management contract scenarios**

Add contract tests for:
- `GET /api/health`
- `GET /api/connection`
- `GET /api/workers`
- `GET /api/resources`
- `GET /api/sessions`
- `GET /api/events`
- `GET /api/tool-calls`
- worker restart/enable/disable actions
- 404 for an unknown worker
- dashboard static root behavior

Assert normalized response status and JSON shape against explicit inline expectations.

- [ ] **Step 4: Verify contract tests**

Run: `npm run test:contracts -- --run tests/contracts/management-api.contract.test.ts`

Expected: PASS against the current Node implementation.

- [ ] **Step 5: Commit**

```bash
git add tests/contracts
git commit -m "test: freeze management API contracts"
```

### Task 3: Freeze MCP ingress and replay-safety contracts

**Files:**
- Create: `tests/contracts/mcp.contract.test.ts`
- Create: `tests/contracts/fixtures/fake-router.ts`
- Create: `tests/contracts/fixtures/fake-worker-client.ts`
- Reference: `apps/server/src/mcp-server.ts`
- Reference: `apps/server/src/mcp-server.test.ts`
- Reference: `packages/router/src/retry-policy.ts`

**Interfaces:**
- Consumes: `createMcpHttpServer`, fake router, and fake `ProxyWorkerClient`.
- Produces: a contract scenario set reusable later by the Rust MCP implementation.

- [ ] **Step 1: Extract deterministic fake router/client fixtures into contract-only files**

The fixtures must support:
- healthy route resolution
- failed resolution
- PRE_DISPATCH failure
- ACK_UNKNOWN failure
- failover tracking
- deterministic `tools/list` and `tools/call` results

- [ ] **Step 2: Add legacy Streamable HTTP contract tests**

Assert:
- initialize/session lifecycle
- `tools/list`
- `tools/call`
- `openai/session` routing metadata
- structured error when no worker is healthy
- PRE_DISPATCH may fail over once
- ACK_UNKNOWN is never replayed

- [ ] **Step 3: Add modern protocol contract tests**

Assert behavior for:
- protocol version `2026-07-28`
- `server/discover`
- `tools/list`
- `tools/call`
- modern result metadata
- unsupported method/error normalization
- unsupported proxy tool metadata sanitization

- [ ] **Step 4: Verify**

Run:
- `npx vitest run tests/contracts/mcp.contract.test.ts`
- `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/contracts/mcp.contract.test.ts tests/contracts/fixtures
git commit -m "test: freeze MCP proxy contracts"
```

### Task 4: Add isolated recovery fixtures

**Files:**
- Create: `tests/recovery/node-manager-recovery.test.ts`
- Create: `tests/recovery/fixtures/managed-child.ts`
- Reuse: `tests/fakes/fake-mcp-worker.ts`
- Reference: `tests/integration/router.integration.test.ts`

**Interfaces:**
- Consumes: `startManager` with fixture process/client dependencies.
- Produces: recovery assertions later reusable against Rust ownership modes.

- [ ] **Step 1: Add worker-crash recovery test**

Assert:
- the crashed bound worker reaches `DEGRADED`
- recovery starts a replacement process for the same worker id
- the session remains bound when recovery succeeds
- no `SESSION_FAILOVER` event is emitted

- [ ] **Step 2: Add failed-recovery failover test**

Assert the binding changes only after the original worker cannot recover and a replacement worker is healthy.

- [ ] **Step 3: Add ambiguous mutation replay-safety test**

Assert an `ACK_UNKNOWN`/ambiguous mutating call is not replayed and is recorded only once by the fixture.

- [ ] **Step 4: Add duplicate-process ownership guard fixture**

Start two fixture manager/supervisor contenders and assert the test harness can detect duplicate ownership. M0 only detects/reports; the Rust mutex behavior is implemented in M2/M3.

- [ ] **Step 5: Verify**

Run:
- `npm run test:recovery`
- `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/recovery
git commit -m "test: add manager recovery fixtures"
```

### Task 5: Build the Node baseline driver

**Files:**
- Create: `tests/benchmarks/node-baseline.ts`
- Create: `tests/benchmarks/fixture-manager-host.ts`
- Create: `tests/benchmarks/benchmark-config.ts`
- Create: `docs/benchmarks/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: benchmark metrics utilities and an isolated manager fixture.
- Produces: `benchmarks/results/node-baseline.json` with raw samples + summaries.

- [ ] **Step 1: Define benchmark configuration**

Export defaults matching the design spec counts and accept CLI overrides for quick local smoke runs. Record OS version, logical CPU count, total RAM, Node version, commit SHA, and timestamp.

- [ ] **Step 2: Implement the isolated manager host**

The host must:
- use a temp DB/runtime root
- bind MCP/API to port 0
- use synthetic fast workers
- expose its own PID and readiness to the parent process
- exit cleanly on a control message

- [ ] **Step 3: Implement benchmark cases**

Measure separately:
- cold process start -> health ready
- manager RSS after readiness
- 500 `tools/list`
- 1000 synthetic `tools/call`
- 100 worker restart cycles
- 20 manager crash/recovery cycles

Store every raw sample and summary.

- [ ] **Step 4: Ignore generated raw benchmark output**

Ignore `benchmarks/results/` while keeping documentation tracked.

- [ ] **Step 5: Document methodology**

In `docs/benchmarks/README.md`, state:
- warmup policy
- sample counts
- percentile definition
- isolation strategy
- difference between manager-ready and workers-ready
- how to reproduce the run

- [ ] **Step 6: Smoke the driver with reduced counts**

Run: `npm run benchmark:node -- --quick`

Expected: exits 0 and writes valid JSON with all benchmark sections.

- [ ] **Step 7: Run the full Node baseline**

Run: `npm run benchmark:node`

Expected: exits 0; preserve the generated raw JSON locally.

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore tests/benchmarks docs/benchmarks/README.md
git commit -m "perf: add reproducible Node baseline harness"
```

### Task 6: Record the accepted Node baseline and M0 gate

**Files:**
- Create: `docs/benchmarks/2026-10-07-node-baseline.md`

**Interfaces:**
- Consumes: the full raw Node baseline JSON.
- Produces: a committed baseline summary used by every later Rust promotion gate.

- [ ] **Step 1: Write the baseline summary**

Record machine metadata, commit SHA, sample counts, median/p95/p99 where applicable, manager RSS, startup, resource-monitor snapshot latency, worker recovery, and notes about the 10 controlled reboot/login observations.

Do not fabricate reboot results; if they have not been run, mark the M0 gate incomplete.

- [ ] **Step 2: Run all M0 validation**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run benchmark:node -- --quick`

Expected: all PASS.

- [ ] **Step 3: Perform/record the controlled reboot observations**

Run the documented Windows recovery procedure 10 times against the fixture/autostart setup, never the live user DB. Record success/failure and any manual intervention.

Expected M0 outcome: a truthful baseline exists even if current Node recovery is below the later Rust target.

- [ ] **Step 4: Commit the baseline summary**

```bash
git add docs/benchmarks/2026-10-07-node-baseline.md
git commit -m "docs: record Node manager baseline"
```

- [ ] **Step 5: Merge gate**

Before PR/merge to `dev`, verify:
- existing tests pass
- new contract/recovery tests pass
- baseline is reproducible
- raw result path is ignored
- no production semantics changed

Then open/merge `feature/rust-baseline -> dev`.
