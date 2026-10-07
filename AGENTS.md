# AGENTS.md - Repository Rules

These instructions apply to the entire repository unless a closer `AGENTS.md` overrides them.

## Mandatory first steps

- Before analyzing or modifying code, find and read the nearest applicable `AGENTS.md`.
- Inspect the current Git branch and `git status` before making changes.
- Never assume local file, process, port, build, test, or Git state; verify it with tools.
- For local machine operations, prefer Desktop Commander Manager through the secure local MCP path.
- Do not use the legacy Remote Desktop Commander when Desktop Commander Manager can perform the task.
- Do not overwrite, revert, stage, or delete unrelated user changes.

## Git workflow

- `main` is the protected stable branch.
- Do not implement features, fixes, refactors, or Rust migration work directly on `main`.
- `dev` is the integration branch for the Rust migration.
- Create feature branches from `dev` for each independently reviewable migration phase.
- Suggested branch names:
  - `feature/rust-platform`
  - `feature/rust-worker-supervisor`
  - `feature/rust-stdio`
  - `feature/rust-db-router`
  - `feature/rust-management-api`
  - `feature/rust-mcp-ingress`
- Merge `feature/* -> dev` only after the phase-specific tests and benchmark gates pass.
- Open `dev -> main` as a Pull Request only after the full validation suite passes.
- Do not merge to `main` merely because code compiles or unit tests pass.
- Do not commit or push unless the user explicitly asks for it or the active plan requires it.

## Rust migration scope

The migration is ROI-driven, not a rewrite-for-purity project.

- Keep the React/TypeScript dashboard architecture.
- Keep `@wonderwhy-er/desktop-commander` workers on Node.js during this migration.
- Keep Secure MCP Tunnel outside the Rust rewrite scope.
- Preserve external contracts unless an approved migration explicitly changes them:
  - MCP endpoint and behavior
  - management API routes and JSON shapes
  - dashboard-facing behavior
  - CLI behavior
  - sticky-session and failover semantics
- Internal database schema and implementation details may change when migration and rollback are explicit.

## Architecture rules
- Use a strangler migration: move one complete capability at a time.
- At any moment, each mutable capability has exactly one authoritative owner: Node or Rust.
- Never allow dual worker supervision.
- Never allow Node and Rust to write the same authoritative state concurrently.
- Shadow mode is read-only and may only compare behavior or performance.
- Prefer a small private stdio protocol for Node <-> Rust sidecar communication during migration.
- Do not introduce extra localhost HTTP services or ports unless a reviewed design requires them.
- Keep portable core logic separate from platform-specific code.
- Windows-native process supervision and resource monitoring should live behind platform interfaces.
- Do not port a subsystem only to increase the percentage of Rust. Stop when remaining Node code has low operational cost and migration ROI no longer clears the agreed gates.

## Migration order

Default order unless a reviewed plan changes it:

1. Baseline, contract tests, and benchmark harness.
2. Rust Windows platform helper: process inspection, metrics, process-tree operations.
3. Rust worker supervisor.
4. Rust stdio MCP worker client.
5. Rust SQLite repository and session router.
6. Rust management API.
7. Evaluate the stop condition.
8. Rust MCP HTTP ingress only if remaining ROI justifies the risk.
9. Simplify native bootstrap/autostart after the Rust manager is authoritative.
## Performance and recovery gates

Use the current Node implementation as the baseline. The agreed Balanced targets are:

- Rust authoritative manager RSS: reduce by at least 40%.
- Manager startup to health-ready: reduce by at least 50%.
- Manager routing overhead p95: no regression greater than 5%.
- Manager routing overhead p99: no regression greater than 10%.
- Resource snapshot p95: reduce by at least 70% and do not spawn PowerShell/CIM sampling processes.
- Worker crash -> READY recovery: median improves by at least 30%; p95 should not exceed 5 seconds in the defined warm-worker test.
- Controlled reboot/login recovery: target at least 99% success with zero manual intervention, zero duplicate managers, and zero duplicate worker trees.

Promote a Rust phase only when correctness, recovery, and performance gates pass. If correctness or recovery fails, roll back. If performance fails, keep the implementation behind a flag and investigate instead of promoting it.

## Validation before merge

Run the checks relevant to the changed subsystem. For the final `dev -> main` PR, require the complete suite:

- TypeScript tests.
- Rust `cargo fmt --check`.
- Rust `cargo clippy --all-targets --all-features -- -D warnings`.
- Rust `cargo test --workspace`.
- Integration and compatibility/contract tests.
- Startup, RSS, and routing benchmarks.
- Worker crash/recovery tests.
- Windows reboot/autostart recovery checks.
- Build production artifacts and run a smoke test.
## Safety and quality rules

- Prefer small, phase-aligned changes over broad rewrites.
- Preserve existing code and comments unless removal is necessary for the approved change.
- Add or update tests before relying on a new behavior.
- Treat SQLite migrations as transactional and rollback-aware.
- Treat persisted PIDs as hints, not durable process identity; verify process identity before acting on them.
- Fail fast on ownership conflicts instead of silently starting a second supervisor.
- Do not add automatic fallback that can create two concurrent owners of mutable state.
- Keep audit/event failures from breaking successful tool calls, but surface operational failures clearly.
- Do not weaken existing secret-redaction behavior in tool-call summaries or logs.

## Documentation and planning

- Significant architectural changes require a reviewed design/spec before implementation.
- Rust migration work should follow the approved design and implementation plan under `docs/superpowers/`.
- If implementation discovers hidden complexity that changes architecture, stop and update the design/plan before continuing.
- Record benchmark methodology alongside benchmark results so Node/Rust comparisons remain reproducible.
- Document rollback instructions for every migration phase before promoting it to `dev`.

## Definition of done for the Rust migration

The migration is complete only when external behavior remains compatible, agreed performance targets are met, recovery is deterministic, rollback has been validated, and the final `dev -> main` Pull Request passes the full validation gates. Reaching 100% Rust is not itself a completion criterion.
