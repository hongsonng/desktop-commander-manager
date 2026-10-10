# M1 Native Platform Benchmark & Promotion Report

**Date:** 2026-10-10  
**Milestone:** M1 (Rust Windows Platform Helper)  
**Target Branch:** `feature/rust-platform`  
**OS:** Windows 10/11 x64 (Build 26300)  
**Rust Toolchain:** rustc 1.99.0 / cargo 1.99.0 (`x86_64-pc-windows-msvc`)  
**Node.js Version:** v24.11.1  

---

## 1. Executive Summary

Milestone M1 introduces native Win32 process inspection, resource sampling, process identity validation, and safe process-tree termination in Rust (`crates/manager-windows` and `dcm-manager sidecar`). This milestone replaces the legacy PowerShell/CIM script sampling pipeline.

### Gate Evaluation

| Requirement / Gate | Target | Measured Result | Status |
|---|---|---|---|
| **Resource Snapshot Latency p95** | $\ge 70\%$ reduction | **99.62% reduction** (2,131.96 ms $\rightarrow$ 8.12 ms) | **PASS** |
| **Resource Snapshot Latency Median**| N/A | **99.65% reduction** (2,000.59 ms $\rightarrow$ 7.06 ms) | **PASS** |
| **Helper Process Spawning** | 0 PowerShell/CIM/taskkill processes spawned | **0 helper processes spawned** (pure Win32 APIs in-process) | **PASS** |
| **Shadow Mode Parity** | Exact process count & identity match | **100% Match** (manager, tunnel, workers) | **PASS** |
| **Rollback Verification** | Deterministic rollback to Node | Verified via `DCM_PLATFORM_OWNER=node` | **PASS** |

---

## 2. Benchmark Comparison (50 Samples)

| Collector | Min | Median | p95 | p99 | Max | Unit |
|---|---|---|---|---|---|---|
| **Node.js PowerShell/CIM Collector** | 1,938.86 | 2,000.59 | 2,131.96 | 2,158.90 | 2,170.83 | ms |
| **Rust Native Sidecar Collector** | 6.13 | **7.06** | **8.12** | 1,786.58 | 1,822.36 | ms |
| **Delta / Speedup** | - | **+99.65%** | **+99.62%** | - | - | - |

> [!NOTE]
> The single cold-start spike in Rust p99 reflects the first snapshot invocation initializing the Toolhelp snapshot and ntdll function pointers. Subsequent invocations sustain ~7 ms median latency.

---

## 3. Rollback Instructions

If unexpected behavior or platform incompatibilities arise:

1. Set the environment variable:
   ```cmd
   set DCM_PLATFORM_OWNER=node
   ```
   Or in PowerShell:
   ```powershell
   $env:DCM_PLATFORM_OWNER = "node"
   ```
2. Restart Desktop Commander Manager.
3. The server immediately reverts to legacy PowerShell/CIM sampling with zero mutation to database schema, routing, or worker state.

---

## 4. Promotion Decision

All M1 correctness, recovery, and performance gates passed.
The default platform capability owner is promoted to `rust` on `feature/rust-platform` for integration into `dev`.
