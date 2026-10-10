# Rust Manager Migration Design

Date: 2026-10-07  
Status: Approved design, pending written-spec review  
Target repository: `desktop-commander-manager`

## 1. Goal

Migrate only the parts of Desktop Commander Manager that gain clear operational value from Rust.

Priority order:

1. Improve Windows stability, autostart, recovery, and process ownership.
2. Reduce manager RSS and startup time.
3. Reduce or preserve tool-call latency.

The migration is ROI-driven. Reaching 100% Rust is not a goal by itself.

## 2. Compatibility contract

The migration must preserve external behavior unless a later reviewed design explicitly changes it.

Stable contracts include:
- MCP endpoint and externally visible MCP behavior.
- Management API routes and JSON shapes.
- Dashboard-facing behavior.
- CLI behavior.
- Sticky-session routing and failover semantics.

Internal implementation, database schema, and autostart internals may change when migration and rollback are explicit.
## 3. Scope

Keep these components unchanged in architecture:
- React/TypeScript dashboard.
- `@wonderwhy-er/desktop-commander` workers on Node.js.
- Secure MCP Tunnel.

Rust targets the manager/control-plane only.

End-state logical components:
- HTTP/MCP ingress.
- Session router and retry/failover.
- SQLite repository.
- Worker lifecycle supervision.
- stdio MCP proxy/client.
- Management API.
- Platform abstraction.
- Windows-native process and resource implementation.

Portable core logic must remain separate from Windows-specific code.

## 4. Target repository layout

```text
apps/
  dashboard/
  server/
  rust-manager/
crates/
  manager-core/
  manager-platform/
  manager-windows/
  manager-worker/
  manager-protocol/
  manager-db/
  manager-router/
  manager-api/
  manager-mcp/
tests/
  contract/
  compatibility/
  recovery/
  benchmarks/
```
## 5. Migration strategy

Use a strangler migration. Move one complete capability at a time.

During migration, Node and Rust may coexist, but mutable capability ownership is exclusive.

Rules:
- One worker process has one supervisor.
- One session binding has one authoritative writer.
- One SQLite database has one authoritative writer.
- Shadow mode is read-only.
- Ownership conflicts fail fast.
- Rollback changes ownership explicitly; it must not silently activate a second owner.

During early phases, Node spawns a long-lived Rust sidecar over a small private stdio protocol.

Do not use MCP as the private Node/Rust protocol.
Do not add internal localhost HTTP ports unless a reviewed design later requires them.

Example capability ownership:

```text
platform_metrics = rust
worker_supervisor = node
worker_stdio = node
database = node
router = node
management_api = node
mcp_ingress = node
```

Each capability may be `node`, `rust`, or `shadow`. Shadow implementations cannot mutate state.

## 6. Ownership transfer

When the database remains Node-owned, Rust process supervision emits lifecycle events and Node persists authoritative state.

When database ownership moves to Rust, it moves as a complete capability. Node must stop writing it.

Worker supervision cut-over must be guarded by a single-instance ownership primitive. On Windows, use a named mutex or equivalent native mechanism. A portable fallback may use a lock file or platform-specific equivalent.
## 7. Migration phases

### M0 - Baseline and contract harness

Before porting behavior, record Node baselines and encode compatibility contracts.

Measure:
- Manager cold startup.
- Manager RSS.
- `/api/resources` latency.
- MCP `tools/list`.
- Synthetic/no-op MCP dispatch overhead.
- Worker restart and crash recovery.
- Manager restart recovery.
- Reboot/login recovery.
- Session stickiness and failover.
- SQLite state preservation.

### M1 - Rust Windows platform helper

Move:
- Process tree enumeration.
- CPU and memory sampling.
- Process existence and identity checks.
- Process tree termination.
- Windows lifecycle primitives.

Replace PowerShell/CIM sampling where possible.

Node remains the authoritative manager.

### M2 - Rust worker supervisor

Rust becomes authoritative for:
- Start, stop, restart.
- Unexpected exit detection.
- Process-tree cleanup.
- Runtime directories.
- Worker lifecycle state transitions.

Desktop Commander workers remain Node processes.

### M3 - Rust stdio MCP worker client

Rust owns:
- Worker stdin/stdout.
- JSON-RPC framing.
- Worker MCP handshake.
- `tools/list`.
- `tools/call`.
- Connection lifecycle.

This phase removes the need for a Node proxy between Rust-owned worker lifecycle and worker stdio.
### M4 - Rust database and session router

Move:
- Workers, sessions, events, and tool-call audit persistence.
- Sticky session resolution.
- Load selection and failover.
- Retry policy integration.

Routing behavior must match the Node implementation before optimization.

### M5 - Rust management API

Port the existing management endpoints without changing dashboard contracts.

### M6 - Stop-condition review

Evaluate whether the remaining Node MCP ingress has enough operational cost or latency impact to justify further migration.

Stopping at a hybrid architecture is acceptable if all agreed outcomes are met.

### M7 - Rust MCP HTTP ingress, conditional

Only proceed if ROI remains positive.

Preserve:
- Legacy streamable HTTP behavior.
- Modern protocol behavior.
- `server/discover`.
- `tools/list` and `tools/call`.
- Session headers.
- OpenAI metadata handling.
- Tool descriptor sanitization.
- Error normalization.
### M8 - Native bootstrap and autostart cleanup

After Rust is the authoritative manager, simplify bootstrap.

Preferred end state:

```text
Windows login
  -> one bootstrap entry
  -> dcm-manager.exe
  -> manager ensures tunnel and workers
```

Avoid retaining multiple overlapping watchdog layers.

## 8. Worker state machine

Worker states are explicit:

```text
STOPPED
  -> STARTING
  -> READY <-> BUSY
  -> DEGRADED
  -> STARTING

DISABLED is terminal until explicitly enabled.
```

Lifecycle transitions must be deterministic and tested.

Unexpected worker exits enter `DEGRADED`, then bounded restart attempts run.
Do not use infinite restart loops.
Suggested restart schedule:

```text
attempt 1: immediate
attempt 2: 500 ms
attempt 3: 1 s
attempt 4: 2 s
attempt 5: 5 s
```

After the bound is exhausted, keep the worker degraded/offline and surface the failure.

## 9. Manager recovery

Manager startup and crash recovery must:

1. Acquire the manager/supervisor ownership lock.
2. Open and migrate SQLite transactionally.
3. Reconcile stale runtime state.
4. Verify persisted process identity before acting on a PID.
5. Clean up orphaned managed trees when required.
6. Start enabled workers.
7. Complete worker MCP handshakes.
8. Expose health, management API, and MCP endpoints.

Persisted PIDs are hints, not durable process identity.
On Windows, verify PID plus creation time and executable/command-line lineage where practical.
## 10. Database semantics

Rust may evolve the internal SQLite schema, but migrations must be transactional and rollback-aware.

Requirements:
- Track schema version.
- Keep a migration log.
- Use short transactions.
- Use prepared statements.
- Prefer WAL mode unless benchmark or correctness data shows otherwise.
- Keep session rebind atomic.
- Persist critical worker transition plus related event atomically where practical.

Do not introduce event sourcing.

## 11. Benchmark gates

Use the Node implementation as the baseline.

Balanced targets:
- Rust authoritative manager RSS: at least 40% lower.
- Manager process start to health-ready: at least 50% faster.
- Manager routing overhead p95: no more than 5% regression.
- Manager routing overhead p99: no more than 10% regression.
- Resource snapshot p95: at least 70% faster.
- Native resource sampling must not spawn PowerShell/CIM helper processes.
- Worker crash-to-READY median: at least 30% faster.
- Worker crash-to-READY p95: at most 5 seconds in the defined warm-worker test.
- Controlled reboot/login recovery: at least 99% successful observations.
- Recovery must require zero manual intervention and create zero duplicate manager or worker trees.
Promotion rule:

```text
promote =
  correctness pass
  AND recovery pass
  AND performance gate pass
  AND operational complexity remains justified
```

If correctness or recovery fails, roll back.
If performance fails while correctness passes, keep the phase behind a flag and investigate.

## 12. Testing strategy

Rust unit tests cover:
- Routing logic.
- Retry/failover.
- Worker state transitions.
- PID identity checks.
- Database migrations.
- Event persistence.

Integration tests cover:
- Rust and SQLite.
- Rust and child processes.
- Rust and Node Desktop Commander workers.
- Node and Rust sidecar protocol.
- Management HTTP API.
- MCP JSON-RPC behavior.
Contract tests run equivalent fixtures against Node and Rust.

Normalize nondeterministic fields such as timestamps and UUIDs before comparison.

Compare:
- HTTP status.
- JSON shape.
- Error code and message semantics.
- Session binding.
- Worker selection.
- Audit records.
- MCP metadata.
- Failover behavior.

Fault-injection coverage must include:
- Worker killed during a tool call.
- Manager killed.
- Rust sidecar killed.
- Stale or reused PID.
- Worker handshake timeout.
- SQLite lock contention.
- Malformed worker JSON-RPC.
- Tunnel unavailable.
- Reboot/login race.
- Two manager instances starting concurrently.

The suite must explicitly assert no duplicate worker trees, no dual supervisor ownership, and no double-written session binding.
## 13. Build and validation

Expected Rust checks:
- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test --workspace`
- `cargo build --release`

Expected project checks:
- Existing TypeScript test suite.
- Integration and contract tests.
- Startup, RSS, and routing benchmarks.
- Worker crash/recovery suite.
- Windows reboot/autostart recovery checks.
- Production build and smoke test.

Early hybrid releases may produce a separate Rust helper executable.
The intended final artifact is a native manager executable plus dashboard assets.

## 14. Git and PR workflow

`main` is protected and stable.
`dev` is the Rust migration integration branch.

Implementation work must use feature branches created from `dev`.

Examples:
- `feature/rust-platform`
- `feature/rust-worker-supervisor`
- `feature/rust-stdio`
- `feature/rust-db-router`
- `feature/rust-management-api`
- `feature/rust-mcp-ingress`
Merge `feature/* -> dev` only after phase-specific tests, benchmarks, and recovery checks pass.

Open `dev -> main` as a Pull Request only after the complete validation suite passes.

Do not code migration work directly on `main`.

## 15. Stop condition

The migration is complete when:
- External behavior remains compatible.
- Agreed performance targets are met.
- Recovery is deterministic.
- Rollback has been validated.
- No duplicate process ownership exists.
- Remaining Node code has low enough operational cost that additional Rust migration is not justified.
- The final `dev -> main` Pull Request passes the full validation gates.

A hybrid end state is acceptable.

## 16. Non-goals

This design does not:
- Rewrite the React dashboard in Rust.
- Rewrite Desktop Commander workers in Rust.
- Rewrite Secure MCP Tunnel.
- Optimize routing semantics before parity is proven.
- Introduce event sourcing.
- Require a Windows Service unless later evidence demonstrates that user-mode bootstrap is insufficient.
