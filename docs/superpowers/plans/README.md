# Rust Manager Migration Plan Set

Design spec: `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

This migration is intentionally split into reviewable plans because the design spans several independently testable subsystems.

Execution order:

1. `2026-10-07-m0-baseline-contract-harness.md` - freeze Node behavior and collect reproducible baselines.
2. `2026-10-07-m1-windows-platform-helper.md` - add the Rust workspace, native Windows process/resource helper, and shadow-mode Node integration.
3. `2026-10-07-m2-m3-worker-runtime.md` - move worker supervision and worker stdio MCP ownership to Rust as one promotion unit.
4. `2026-10-07-m4-state-router.md` - move SQLite/session routing ownership to Rust while Node keeps public HTTP.
5. `2026-10-07-m5-management-api.md` - move management API/dashboard serving to Rust.
6. `2026-10-07-m6-stop-condition-review.md` - measure whether the hybrid result already meets the goals.
7. `2026-10-07-m7-mcp-ingress-standalone.md` - conditional: port MCP ingress and remove the Node control-plane host.
8. `2026-10-07-m8-native-autostart.md` - conditional after M7: switch login recovery to one native Rust manager entry.

Branch policy:

- `main` remains stable.
- `dev` is the integration branch.
- Each plan executes on a feature branch created from the latest passing `dev`.
- Merge `feature/* -> dev` only after that plan's tests, benchmarks, recovery checks, and rollback validation pass.
- Open `dev -> main` only after the final full validation gate passes.

Current planning baseline:

- `dev` worktree: `D:\SonCFS\desktop-commander-manager\.worktrees\dev`
- Baseline tests before planning: 13 files / 44 tests passing.
- Rust toolchain is not currently available in PATH; M1 includes the required bootstrap/preflight.
