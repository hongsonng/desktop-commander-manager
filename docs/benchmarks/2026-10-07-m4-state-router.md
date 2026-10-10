# M4 Rust State Repository & Session Router Benchmark & Promotion Report

**Date:** 2026-10-10  
**Milestone:** M4 (Rust SQLite Repository, Atomic Transitions, and Sticky-Session Router)  
**Target Branch:** `feature/rust-db-router`  
**OS:** Windows 10/11 x64 (Build 26300)  
**Hardware:** 6 Logical CPUs, 32 GB RAM  
**Rust Toolchain:** rustc 1.99.0 / cargo 1.99.0 (`x86_64-pc-windows-msvc`)  
**Node.js Version:** v24.11.1  

---

## 1. Executive Summary

Milestone M4 moves authoritative state persistence (SQLite database schema migrations, WAL mode, session bindings, worker metadata, and audit logs) and sticky-session routing logic to Rust (`crates/manager-db`, `crates/manager-router`, and `apps/rust-manager sidecar`). Node retains public MCP HTTP ingress and management HTTP API endpoints, interfacing with the Rust state/routing backend over the existing private stdio protocol.

Single mutable state ownership is strictly preserved:
- When `stateOwner: 'rust'`, Node never opens or writes SQLite directly.
- When `stateOwner: 'node'`, the system uses existing Node SQLite repositories and routers.
- Cross-language database rollback (Node -> Rust -> Node) has been proven to preserve 100% of persisted data and session bindings without data loss.

### Gate Evaluation

| Requirement / Gate | Target | Measured Result | Status |
|---|---|---|---|
| **Routing Overhead p95 Regression** | Regression $\le 5\%$ | **-79.47% regression (31.33 ms $\rightarrow$ 6.43 ms, 79.5% faster)** | **PASS** |
| **Routing Overhead p99 Regression** | Regression $\le 10\%$ | **-79.81% regression (40.16 ms $\rightarrow$ 8.11 ms, 79.8% faster)** | **PASS** |
| **`tools/list` p95 Latency** | No regression | **58.0% faster (9.43 ms $\rightarrow$ 3.96 ms)** | **PASS** |
| **Management API p95 Latency** | No regression | **Parity / Faster (1.49 ms $\rightarrow$ 1.49 ms, mean 1.13 ms vs 1.26 ms)** | **PASS** |
| **Concurrent Session Binding Stress** | Zero race/lock corruption | 30 parallel requests: 100% success, 30 durable bindings | **PASS** |
| **State Ownership Rollback** | Zero data loss Node $\leftrightarrow$ Rust | Verified in `tests/recovery/state-owner-rollback.test.ts` | **PASS** |
| **Contract Compatibility** | 100% test pass rate | All Vitest suites (82 tests across 23 files) & all Cargo tests pass | **PASS** |

---

## 2. Benchmark Comparison

### A. Routing Overhead Latency (`tools/call` & `tools/list`)

Measured over 150 requests per configuration using isolated benchmark harness isolating pure manager routing overhead:

| Metric | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node Baseline `tools/call`** | 150 | 11.84 | 23.91 | 31.33 | 40.16 | 23.68 | ms |
| **Rust State & Router `tools/call`** | 150 | 3.44 | **4.83** | **6.43** | **8.11** | **4.76** | ms |
| **Delta / Speedup** | - | - | **+79.78%** | **+79.47%** | **+79.81%** | **+79.90%** | - |
| **Node Baseline `tools/list`** | 150 | 5.55 | 7.41 | 9.43 | 18.11 | 7.56 | ms |
| **Rust State & Router `tools/list`** | 150 | 2.27 | **3.52** | **3.96** | **4.32** | **3.20** | ms |
| **Delta / Speedup** | - | - | **+52.50%** | **+58.02%** | **+76.14%** | **+57.72%** | - |

> [!NOTE]
> By eliminating Node-to-Rust and Node-SQLite serialization hops for session routing and performing session lookups and tie-breaking directly inside the Rust engine, median tool call routing dropped from ~23.9 ms to ~4.8 ms.

### B. Management API Performance (`/api/workers` & `/api/sessions`)

| Metric | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node State Owner** | 150 | 0.98 | 1.07 | 1.49 | 4.46 | 1.26 | ms |
| **Rust State Owner** | 150 | 0.94 | 1.04 | 1.49 | 5.14 | 1.13 | ms |

---

## 3. Rollback Instructions

If state persistence or session router behavior requires rollback:

1. Revert the state owner flag:
   ```cmd
   set DCM_STATE_OWNER=node
   ```
   Or in PowerShell:
   ```powershell
   $env:DCM_STATE_OWNER = "node"
   ```
2. Restart Desktop Commander Manager.
3. The server immediately falls back to Node.js SQLite repositories and TypeScript `SessionRouter` with zero disruption to session persistence, MCP endpoints, or routing contracts.
4. Database schema compatibility is bidirectional: Node opens the database files written or migrated by Rust without schema conflicts.

---

## 4. Promotion Decision

All M4 correctness, recovery, rollback, and performance gates passed.
The Rust database repository and session router are verified and approved for promotion on `feature/rust-db-router` to be merged into `dev`.
