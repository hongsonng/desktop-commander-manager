# M6 Stop-Condition Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide from measured data whether the hybrid Rust-manager/Node-MCP-ingress architecture already satisfies the migration goals or whether M7/M8 are justified.

**Architecture:** No production subsystem is ported in M6. Re-run the standardized M0 benchmark/recovery suites against the latest passing `dev`, attribute remaining control-plane cost to Node vs Rust, and issue a committed `STOP_HYBRID` or `CONTINUE_M7` decision with evidence.

**Tech Stack:** Existing benchmark/contract/recovery harness, Windows process/resource sampler, Git documentation.

**Spec:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`

## Global Constraints

- Work on `feature/rust-stop-review` created from the latest passing `dev` after M5 merges.
- Do not modify production behavior to make the numbers look better during this review.
- Compare against the accepted M0 Node baseline on the same machine/methodology.
- Measure the combined control-plane RSS when both Node ingress and Rust runtime are required.
- Hard targets remain: RSS >= 40% reduction, startup >= 50% faster, p95 manager overhead regression <= 5%, p99 <= 10%, deterministic recovery, and validated rollback.
- M1 resource and M2-M3 worker-recovery gates must remain passing.
- `STOP_HYBRID` is a valid success outcome; 100% Rust is not required.
- If any hard target is not met, document which remaining Node component can plausibly affect it before choosing M7.

## Review Focus

- Do not compare a warm Rust run against a cold Node baseline; startup/cache conditions must match.
- Combined RSS must include the Node ingress host, Rust process, and any always-on helper required by the architecture, but not the Desktop Commander workers/tunnel when comparing manager control-plane memory.
- Tool-call latency must isolate manager overhead from worker tool execution.
- Recovery success must distinguish worker recovery from tunnel/network availability.
- A decision to continue must cite a measurable deficit or operational simplification; “more Rust” is not evidence.

---

### Task 1: Re-run the full accepted benchmark matrix

**Files:**
- Create: `docs/benchmarks/2026-10-07-m6-stop-review.md`

**Interfaces:**
- Consumes M0, M1, M2-M3, M4, and M5 benchmark records.
- Produces one normalized comparison table.

- [ ] **Step 1: Re-run cold startup samples**

Measure process launch -> manager health-ready and separately -> all enabled workers READY.

- [ ] **Step 2: Re-run control-plane RSS samples**

Record Node process RSS, Rust process RSS, combined RSS, and compare combined RSS against M0 Node manager RSS.

Hard gate: combined control-plane RSS <= 60% of the accepted Node baseline.

- [ ] **Step 3: Re-run synthetic MCP overhead samples**

Measure `tools/list` and fast/no-op `tools/call`; report p50/p95/p99.

Hard gates: p95 <= Node baseline * 1.05; p99 <= Node baseline * 1.10.

- [ ] **Step 4: Re-run resource and worker-recovery gates**

Confirm M1 snapshot p95 improvement >= 70%, zero helper-process spawning, M2-M3 recovery median improvement >= 30%, and warm p95 <= 5 seconds.

- [ ] **Step 5: Re-run controlled recovery checks**

Cover manager crash, Rust process crash, worker crash, ownership conflict, rollback to Node modes, and the documented reboot/login observations available at this stage.

- [ ] **Step 6: Write the comparison table**

Include raw sample counts and links/paths to local raw JSON output; do not commit large raw data files.

### Task 2: Attribute remaining Node ingress cost

**Files:**
- Modify: `docs/benchmarks/2026-10-07-m6-stop-review.md`

**Interfaces:**
- Produces a quantified estimate of what M7 can actually improve.

- [ ] **Step 1: Measure Node ingress idle RSS**

With all state/worker/API ownership in Rust, measure the remaining Node MCP host at idle.

- [ ] **Step 2: Measure Node ingress dispatch contribution**

Use timestamps around Node MCP parse/metadata/sanitize/proxy boundaries to estimate its p50/p95 contribution without changing response behavior.

- [ ] **Step 3: Inventory remaining Node operational dependencies**

List required runtime pieces after M5:
- Node executable
- npm/tsx or compiled host requirement
- MCP SDK/Fastify dependencies still needed solely for ingress
- current autostart/watchdog scripts required to launch the hybrid process

- [ ] **Step 4: Estimate M7/M8 payoff**

State which hard target or operational complexity would improve if Node ingress/bootstrap were removed.

### Task 3: Issue and commit the stop decision

**Files:**
- Modify: `docs/benchmarks/2026-10-07-m6-stop-review.md`
- Create: `docs/superpowers/decisions/2026-10-07-rust-migration-stop-condition.md`

**Interfaces:**
- Produces exactly one decision: `STOP_HYBRID` or `CONTINUE_M7`.

- [ ] **Step 1: Run full validation before decision**

Run:
- `npm test`
- `npm run test:contracts`
- `npm run test:recovery`
- `npm run build`
- `npm run lint:rust`
- `npm run test:rust`

Expected: PASS.

- [ ] **Step 2: Choose `STOP_HYBRID` only if all hard goals are already met**

The decision document must state that M7 and native bootstrap are not justified now and identify the retained Node ingress/launch path.

- [ ] **Step 3: Choose `CONTINUE_M7` if a hard goal or material stability/deployment simplification remains**

Cite measured data and the expected benefit. Do not continue merely for language purity.

- [ ] **Step 4: Commit**

```bash
git add docs/benchmarks/2026-10-07-m6-stop-review.md docs/superpowers/decisions/2026-10-07-rust-migration-stop-condition.md
git commit -m "docs: decide Rust migration stop condition"
```

- [ ] **Step 5: Merge the review branch**

Review and merge `feature/rust-stop-review -> dev`.

If decision is `STOP_HYBRID`, do not execute M7/M8 without a new reviewed decision.
If decision is `CONTINUE_M7`, execute the M7 plan next.
