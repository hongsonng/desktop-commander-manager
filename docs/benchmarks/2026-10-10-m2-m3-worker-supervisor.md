# M2-M3 Rust Worker Supervisor Benchmark & Promotion Report

**Date:** 2026-10-10  
**Milestone:** M2-M3 (Rust Worker Runtime, Supervisor, and Stdio JSON-RPC Client)  
**Target Branch:** `feature/rust-worker-supervisor`  
**OS:** Windows 10/11 x64 (Build 26300)  
**Hardware:** 6 Logical CPUs, 32 GB RAM  
**Rust Toolchain:** rustc 1.99.0 / cargo 1.99.0 (`x86_64-pc-windows-msvc`)  
**Node.js Version:** v24.11.1  

---

## 1. Executive Summary

Milestones M2 and M3 introduce the authoritative Rust Worker Runtime and Supervisor (`crates/manager-worker` and `apps/rust-manager sidecar`). This subsystem manages the lifecycle of pinned Node.js `@wonderwhy-er/desktop-commander@0.2.52` workers via standard I/O JSON-RPC, enforces single-supervisor ownership through Windows named mutex (`Local\DesktopCommanderManager.WorkerSupervisor`), and performs deterministic crash detection and bounded exponential backoff recovery.

### Gate Evaluation

| Requirement / Gate | Target | Measured Result | Status |
|---|---|---|---|
| **Warm Worker Crash Recovery p95** | $\le 5,000$ ms | **1,575.80 ms** (Real Desktop Commander worker) | **PASS** |
| **Supervisor Recovery Median Speedup** | $\ge 30\%$ improvement | **58.54% improvement** (194.20 ms $\rightarrow$ 80.51 ms) | **PASS** |
| **Routing Overhead p95 Regression** | Regression $\le 5\%$ | **-21.10% regression (30.10 ms $\rightarrow$ 23.75 ms, faster)** | **PASS** |
| **Routing Overhead p99 Regression** | Regression $\le 10\%$ | **-34.29% regression (38.65 ms $\rightarrow$ 25.40 ms, faster)** | **PASS** |
| **Single Supervisor Guard** | No dual supervision | Enforced via Windows Named Mutex | **PASS** |
| **Contract Compatibility** | 100% test pass rate | All 21 Vitest suites (75 tests) & all Cargo tests pass | **PASS** |

---

## 2. Benchmark Comparison

### A. Crash Recovery Latency

| Harness / Workload | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node.js Baseline Supervisor** | 20 | 145.20 | **194.20** | 270.52 | 310.84 | 202.15 | ms |
| **Rust Supervisor (Overhead Harness)** | 25 | 78.03 | **80.51** | **83.42** | 88.54 | 80.93 | ms |
| **Delta / Speedup** | - | - | **+58.54%** | **+69.16%** | - | - | - |
| **Rust Warm Worker (Desktop Commander)** | 10 | 1,414.20 | **1,419.49** | **1,575.80** | 1,575.80 | 1,441.60 | ms |

> [!NOTE]
> In the warm-worker test, real Desktop Commander worker processes take ~1.3 seconds for Node runtime initialization. Rust supervisor automatically detects crash and returns the warm worker to `READY` state in 1.58s p95, well under the 5-second requirement.

### B. Routing Latency (`tools/list` & `tools/call`)

| Metric | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node Baseline `tools/list`** | 500 | 14.12 | 19.85 | 34.27 | 44.52 | 21.04 | ms |
| **Rust Sidecar `tools/list`** | 200 | 12.77 | **24.31** | **26.93** | 28.81 | 23.80 | ms |
| **Node Baseline `tools/call`** | 1,000 | 14.05 | 19.42 | 30.10 | 38.65 | 20.31 | ms |
| **Rust Sidecar `tools/call`** | 200 | 11.69 | **13.60** | **23.75** | 25.40 | 14.48 | ms |

---

## 3. Rollback Instructions

If worker supervisor behavior requires rollback:

1. Revert the capability owner flag:
   ```cmd
   set DCM_WORKER_OWNER=node
   ```
   Or in PowerShell:
   ```powershell
   $env:DCM_WORKER_OWNER = "node"
   ```
2. Restart Desktop Commander Manager.
3. The server immediately falls back to Node.js `WorkerManager` with zero disruption to session persistence, MCP endpoints, or routing contracts.

---

## 4. Promotion Decision

All M2-M3 correctness, recovery, and performance gates passed.
The Rust worker supervisor is verified and approved for promotion on `feature/rust-worker-supervisor` to be merged into `dev`.
