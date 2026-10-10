# M2-M3 Rust Worker Supervisor Benchmark & Promotion Report

**Date:** 2026-10-10  
**Milestone:** M2-M3 (Rust Worker Runtime, Supervisor, and Stdio JSON-RPC Client)  
**Measured Commit:** `f27ed0a416498758f0337049045b7457cfee66fd`\
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
| **Warm Worker Crash Recovery p95** | $\le 5,000$ ms | **1,578.03 ms** (Real Desktop Commander worker) | **PASS** |
| **Supervisor Recovery Median Speedup** | $\ge 30\%$ improvement | **57.14% improvement** (194.20 ms $\rightarrow$ 83.23 ms) | **PASS** |
| **Routing Overhead p95 Regression** | Regression $\le 5\%$ | **-23.18% regression (30.10 ms $\rightarrow$ 23.12 ms, faster)** | **PASS** |
| **Routing Overhead p99 Regression** | Regression $\le 10\%$ | **-32.81% regression (38.65 ms $\rightarrow$ 25.97 ms, faster)** | **PASS** |
| **Single Supervisor Guard** | No dual supervision | Enforced via Windows Named Mutex | **PASS** |
| **Contract Compatibility** | 100% test pass rate | All 26 Vitest files (91 tests) & all workspace Cargo tests pass | **PASS** |

---

## 2. Benchmark Comparison

### A. Crash Recovery Latency

| Harness / Workload | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node.js Baseline Supervisor** | 20 | 145.20 | **194.20** | 270.52 | 310.84 | 202.15 | ms |
| **Rust Supervisor (Overhead Harness)** | 25 | 80.94 | **83.23** | **86.56** | 86.67 | 83.57 | ms |
| **Delta / Speedup** | - | - | **+57.14%** | **+68.00%** | - | - | - |
| **Rust Warm Worker (Desktop Commander)** | 10 | 1,402.55 | **1,418.81** | **1,578.03** | 1,578.03 | 1,440.79 | ms |

> [!NOTE]
> In the warm-worker test, the Rust supervisor automatically detects a crash and returns the real Desktop Commander worker to `READY` state in 1.58s p95, well under the 5-second requirement.

### B. Routing Latency (`tools/list` & `tools/call`)

| Metric | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Node Baseline `tools/list`** | 500 | 14.12 | 19.85 | 34.27 | 44.52 | 21.04 | ms |
| **Rust Sidecar `tools/list`** | 200 | 11.48 | **23.66** | **25.96** | 30.35 | 23.05 | ms |
| **Node Baseline `tools/call`** | 1,000 | 14.05 | 19.42 | 30.10 | 38.65 | 20.31 | ms |
| **Rust Sidecar `tools/call`** | 200 | 11.67 | **13.63** | **23.12** | 25.97 | 14.58 | ms |

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
