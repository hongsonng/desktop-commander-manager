# M8 Native Bootstrap and Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the PowerShell watchdog/bootstrap chain with one no-admin Windows autostart entry that launches standalone dcm-manager.exe, while the Rust manager supervises the existing Secure MCP Tunnel client and Desktop Commander workers.

**Architecture:** Add native Windows autostart registration/status/uninstall APIs to the Rust platform layer. Prefer a LIMITED ONLOGON Task Scheduler entry when allowed and fall back to HKCU Run when task creation is denied. The registered command launches dcm-manager.exe run directly; after MCP/API are healthy the manager owns one tunnel supervisor for the existing tunnel-client profile, so the separate tunnel autostart entry is removed.

**Tech Stack:** Rust Windows APIs/COM through the windows crate, existing Rust standalone manager, existing tunnel-client executable/profile, current Windows smoke/recovery harness.

**Spec:** docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md

## Global Constraints

- Execute only after M7 has passed and merged to dev.
- Work on feature/rust-autostart created from the latest passing dev.
- No Windows Service requirement; install and run under the current user without elevation.
- Keep task name DesktopCommanderManager and remove/disable the separate DesktopCommanderTunnel autostart entry after manager-owned tunnel supervision is validated.
- Task Scheduler creation uses ONLOGON + LIMITED privileges; Access Denied falls back to HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
- The autostart command launches dcm-manager.exe directly; no PowerShell launcher, WMI/CIM bootstrap, npm, or tsx is allowed on the login critical path.
- Secure MCP Tunnel itself is not rewritten.
- Resolve tunnel-client from PATH or %LOCALAPPDATA%\Programs\OpenAI\tunnel-client\tunnel-client.exe.
- Tunnel profile remains desktop-commander-manager.
- Preserve doctor --profile desktop-commander-manager --explain before starting run --profile desktop-commander-manager.
- Do not delete legacy scripts until the native path and rollback have both been validated; unregistered legacy files are acceptable, overlapping active watchdogs are not.
- Final controlled login/reboot observations require zero manual recovery, zero duplicate manager processes, zero duplicate worker trees, and zero duplicate matching tunnel runners.

## Review Focus

- Paths containing spaces/non-ASCII characters must be quoted correctly in Task Scheduler and HKCU Run commands.
- Task creation Access Denied must cleanly fall back to Run key without leaving two active entries.
- An already-running matching tunnel profile must be detected/adopted or left alone; never spawn a duplicate.
- Tunnel doctor failures or tunnel exits must not crash the manager or workers.
- Upgrade/install over legacy autostart entries must be idempotent and rollbackable.

---
### Task 1: Implement native Windows autostart registration primitives

**Files:**
- Create: crates/manager-windows/src/autostart.rs
- Create: crates/manager-windows/tests/autostart.windows.rs
- Modify: crates/manager-windows/src/lib.rs
- Reference: apps/server/src/windows-autostart.ts

**Interfaces:**
- Produces:
  - AutostartMechanism::Task | RunKey | None
  - install_manager_autostart(executable, root) -> Result<AutostartMechanism, AutostartError>
  - manager_autostart_status() -> Result<AutostartMechanism, AutostartError>
  - uninstall_manager_autostart() -> Result<(), AutostartError>
  - remove_legacy_tunnel_autostart() -> Result<(), AutostartError>

- [ ] **Step 1: Write command/registration quoting tests**

Use fixture paths with spaces and Unicode. Assert the resulting action command represents exactly:
"dcm-manager.exe" run --root "<root>"

- [ ] **Step 2: Write task-success and task-denied fallback tests behind an OS adapter**

Fake Task Scheduler success -> Task and no Run entry.
Fake Access Denied -> RunKey and no active Task entry.

- [ ] **Step 3: Implement Task Scheduler COM registration**

Create/update DesktopCommanderManager as current-user ONLOGON with LIMITED run level.

- [ ] **Step 4: Implement HKCU Run fallback with registry APIs**

Write a direct executable command line; do not register PowerShell.

- [ ] **Step 5: Implement status/uninstall/idempotency**

Repeated install must converge to one active manager mechanism. Uninstall removes both task and Run entry.

- [ ] **Step 6: Implement legacy tunnel entry cleanup**

Remove DesktopCommanderTunnel Task Scheduler and Run-key entries only after the manager autostart entry has installed successfully.

- [ ] **Step 7: Verify**

Run: cargo test -p manager-windows autostart

Expected: PASS on Windows.

- [ ] **Step 8: Commit**

git add crates/manager-windows
git commit -m "feat: register manager autostart natively"

### Task 2: Add native autostart CLI commands

**Files:**
- Create: apps/rust-manager/src/autostart_cli.rs
- Create: apps/rust-manager/tests/autostart_cli.rs
- Modify: apps/rust-manager/src/main.rs
- Modify: package.json

**Interfaces:**
- Commands:
  - dcm-manager autostart install --root <path>
  - dcm-manager autostart status
  - dcm-manager autostart uninstall
- npm autostart scripts invoke the built Rust manager instead of the TypeScript autostart CLI after promotion.

- [ ] **Step 1: Write CLI parsing/output tests**

Preserve concise human-readable mechanism labels: Task Scheduler, HKCU Run, not installed.

- [ ] **Step 2: Implement install/status/uninstall commands**

Install validates the standalone manager executable/root and dashboard/runtime prerequisites before changing registration.

- [ ] **Step 3: Keep legacy TypeScript autostart code available for rollback**

Do not execute it from the promoted npm scripts. Do not delete it in this task.

- [ ] **Step 4: Update npm scripts after native CLI tests pass**

autostart:install/status/uninstall must target the Rust artifact/command path documented by the build.

- [ ] **Step 5: Verify**

Run:
- cargo test -p dcm-manager autostart_cli
- npm test
- npm run build:manager

Expected: PASS.

- [ ] **Step 6: Commit**

git add apps/rust-manager package.json
git commit -m "feat: expose native manager autostart CLI"
### Task 3: Add the Rust Secure MCP Tunnel supervisor

**Files:**
- Modify: `crates/manager-core/Cargo.toml`
- Modify: `crates/manager-core/src/lib.rs`
- Create: `crates/manager-core/src/tunnel_supervisor.rs`
- Create: `crates/manager-core/tests/tunnel_supervisor.rs`
- Modify: `crates/manager-core/src/runtime.rs`
- Reference: `scripts/run-tunnel-headless.ps1`

**Interfaces:**
- Produces:
  - TunnelConfig { executable, profile_name, log_path }
  - TunnelSupervisor::start(config, process_platform) -> Result<TunnelSupervisor, TunnelError>
  - TunnelSupervisor::shutdown()
- Profile name is desktop-commander-manager.
- Readiness command is doctor --profile desktop-commander-manager --explain.
- Run command is run --profile desktop-commander-manager.

- [ ] **Step 1: Write executable-resolution tests**

Resolution order:
1. tunnel-client found in PATH
2. %LOCALAPPDATA%\Programs\OpenAI\tunnel-client\tunnel-client.exe
3. unavailable -> supervisor disabled with an explicit diagnostic, matching current skip behavior

- [ ] **Step 2: Write doctor/retry tests with a fake tunnel executable**

When doctor fails, retry after 60 seconds using a fake clock. Do not start run until doctor succeeds.

- [ ] **Step 3: Write run-exit restart tests**

When the tunnel process exits, retry after 5 seconds without restarting the manager/workers.

- [ ] **Step 4: Write duplicate-profile detection test**

If a matching tunnel-client run --profile desktop-commander-manager process already exists, do not spawn a second matching process. Monitor/recheck the existing identity until it exits or manager shutdown occurs.

- [ ] **Step 5: Implement supervisor**

Log tunnel lifecycle under data/logs without writing protocol output to manager stdout.

- [ ] **Step 6: Wire startup ordering**

Standalone manager starts authoritative core + workers + MCP/API listeners first, then starts/attaches tunnel supervision.

- [ ] **Step 7: Wire graceful shutdown**

Stop only a tunnel process that the manager started. Do not kill an externally owned matching tunnel process merely because the manager is shutting down.

- [ ] **Step 8: Verify**

Run:
- cargo test -p manager-core tunnel_supervisor
- cargo test --workspace
- isolated smoke with fake tunnel executable

Expected: PASS.

- [ ] **Step 9: Commit**

git add crates/manager-core
git commit -m "feat: supervise Secure MCP Tunnel from Rust manager"

### Task 4: Switch active autostart from legacy watchdogs to the native manager

**Files:**
- Create: docs/autostart-rust.md
- Modify: `scripts/run-manager-headless.ps1` to add a top-of-file deprecation/rollback note; keep its legacy behavior intact.
- Modify: `scripts/run-tunnel-headless.ps1` to add a top-of-file deprecation/rollback note; keep its legacy behavior intact.
- Do not remove launch-autostart-runner.ps1 in this migration unless a later cleanup is explicitly approved.

**Interfaces:**
- Active login path becomes one DesktopCommanderManager Task/Run entry -> dcm-manager.exe run.
- No active DesktopCommanderTunnel entry remains.

- [ ] **Step 1: Document pre-switch state capture**

Before installation, record current task/run-key status so rollback can restore the previous mechanism if native validation fails.

- [ ] **Step 2: Build the production manager artifact**

Run: npm run build:manager

Expected: dist/dcm-manager.exe and dashboard assets exist.

- [ ] **Step 3: Install native manager autostart**

Run the new Rust autostart install command.

Assert exactly one manager mechanism reports active.

- [ ] **Step 4: Confirm legacy tunnel autostart is inactive**

Task/Run status for DesktopCommanderTunnel must be absent while the manager-owned tunnel supervisor is active/ready when profile prerequisites exist.

- [ ] **Step 5: Smoke without reboot**

Terminate the test manager/tunnel only through controlled fixture/ownership paths, invoke the registered startup command manually, and verify:
- one manager
- both public ports healthy
- enabled workers READY
- one matching tunnel profile
- no PowerShell watchdog/bootstrap process

- [ ] **Step 6: Document rollback**

Rollback:
1. uninstall native manager autostart
2. stop standalone manager cleanly
3. restore legacy Node ownership configuration
4. reinstall legacy autostart only if a tested rollback is actually required

- [ ] **Step 7: Commit**

git add docs/autostart-rust.md scripts/run-manager-headless.ps1 scripts/run-tunnel-headless.ps1
git commit -m "docs: switch to native manager autostart"
### Task 5: Add controlled login/reboot recovery evidence

**Files:**
- Create: scripts/verify-native-autostart.ps1
- Create: docs/benchmarks/2026-10-07-m8-autostart-recovery.md

**Interfaces:**
- Verification script is read-only with respect to manager state: it inspects health, process ownership, ports, worker states, and tunnel duplicates and emits a timestamped result record.

- [ ] **Step 1: Implement post-login verifier**

Record:
- /api/health status and uptime
- MCP port 8787/listener PID
- management port 8788/listener PID
- manager process count
- each enabled worker READY/pid
- matching tunnel profile process count
- presence of legacy PowerShell watchdog/bootstrap processes

Exit nonzero if any duplicate/health violation exists.

- [ ] **Step 2: Test verifier against controlled good/bad fixture states**

Pin failures for duplicate manager, missing worker readiness, duplicate tunnel, and legacy watchdog presence.

- [ ] **Step 3: Perform the controlled login/reboot observation set**

For each observation, run the verifier after login recovery. Record startup-to-health and startup-to-workers/tunnel-ready where measurement is available.

Current sample gate: all 10 planned observations must pass (10/10). Long-run target remains >=99% cumulative success.

Because reboot interrupts the current execution channel, never claim an observation that was not actually recorded by the verifier/log.

- [ ] **Step 4: Verify zero manual intervention**

Every passing observation must require no manual manager/tunnel restart and show zero duplicate process trees.

- [ ] **Step 5: Commit verifier and evidence**

git add scripts/verify-native-autostart.ps1 docs/benchmarks/2026-10-07-m8-autostart-recovery.md
git commit -m "test: verify native autostart recovery"

### Task 6: Final migration validation and dev-to-main PR gate

**Files:**
- Create: docs/benchmarks/2026-10-07-rust-migration-final.md
- Update migration docs only with measured final values.

**Interfaces:**
- Produces the final evidence package required before opening dev -> main.

- [ ] **Step 1: Run every project test/build gate**

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

- [ ] **Step 2: Re-run final balanced performance gates**

Confirm:
- standalone manager RSS >= 40% lower than M0 baseline
- startup >= 50% faster
- manager p95 overhead regression <= 5%
- manager p99 overhead regression <= 10%
- resource snapshot p95 >= 70% faster with no helper PowerShell/CIM process
- worker crash-to-READY median >= 30% faster and p95 <= 5 seconds

- [ ] **Step 3: Re-run recovery/ownership gates**

Confirm:
- no duplicate manager
- no duplicate worker tree
- no dual DB writer
- no duplicate matching tunnel runner
- rollback to Node compatibility path remains documented/validated
- controlled login/reboot evidence meets the current sample gate

- [ ] **Step 4: Write the final migration report**

List each target with baseline, final value, pass/fail, exact command/method, and rollback status. State whether M6/M7/M8 were all executed or any conditional phase was skipped.

- [ ] **Step 5: Commit final evidence**

git add docs/benchmarks/2026-10-07-rust-migration-final.md
git commit -m "docs: record final Rust migration results"

- [ ] **Step 6: Merge feature/rust-autostart -> dev only after all M8 gates pass**

Do not bypass a failed benchmark/recovery gate.

- [ ] **Step 7: Run the same full validation on the final dev head**

The dev branch itself, not only feature branches, must pass the complete suite.

- [ ] **Step 8: Open Pull Request dev -> main**

PR must include:
- design spec
- plan set
- phase benchmark links
- final validation results
- compatibility statement
- rollback instructions
- known retained legacy rollback files, if any

Do not merge the PR to main until review passes and all required checks are green.
