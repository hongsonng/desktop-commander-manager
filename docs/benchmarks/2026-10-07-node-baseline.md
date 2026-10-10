# Node.js Baseline Benchmark Report

**Date:** 2026-10-10  
**Target Commit:** `681e0e05ffa7ce1f8d4c4c28df2cf4f3cae4ee71`  
**OS:** Windows 10/11 x64 (Build 26300)  
**Hardware:** 6 Logical CPUs, 32 GB RAM  
**Node.js Version:** v24.11.1  

---

## 1. Executive Summary

This report establishes the frozen performance baseline of Desktop Commander Manager running on the Node.js 22 runtime prior to introducing Rust subsystems. Every subsequent Rust promotion gate (Milestones M1 through M6) must measure against these verified metrics.

### Key Target Gates for Rust Migration:
- **Manager RSS:** Target $\ge$ 40% reduction from baseline median (~103.27 MB $\rightarrow \le$ 61.96 MB).
- **Startup to Health-Ready:** Target $\ge$ 50% reduction from baseline median (~687.36 ms $\rightarrow \le$ 343.68 ms).
- **Routing Overhead:** p95 latency regression $\le$ 5%; p99 regression $\le$ 10%.
- **Resource Snapshot Latency:** Target $\ge$ 70% reduction by replacing CIM/PowerShell with native Win32/Rust APIs.
- **Worker Crash Recovery:** Median recovery time improvement $\ge$ 30%; p95 $\le$ 5,000 ms.

---

## 2. Benchmark Results

| Metric | Sample Count | Min | Median | p95 | p99 | Mean | Unit |
|---|---|---|---|---|---|---|---|
| **Cold Start (Process -> Ready)** | 50 | 437.59 | **687.36** | **2,121.83** | 6,337.87 | 879.01 | ms |
| **Manager RSS** | 50 | 83.73 | **98.49** (103.27 MB) | **111.77** (117.20 MB) | 113.62 | 99.27 | MB |
| **`tools/list` Latency** | 500 | 14.12 | **19.85** | **34.27** | 44.52 | 21.04 | ms |
| **`tools/call` Latency** | 1,000 | 14.05 | **19.42** | **30.10** | 38.65 | 20.31 | ms |
| **Worker Restart Cycle** | 100 | 210.15 | **268.45** | **537.04** | 682.11 | 291.12 | ms |
| **Worker Crash -> Ready Recovery**| 20 | 145.20 | **194.20** | **270.52** | 310.84 | 202.15 | ms |

---

## 3. Methodology & Environment Notes

1. **Isolation:** Tested with synthetic ephemeral ports, isolated temporary runtime databases, and zero mutation on user production databases.
2. **Fast Workers:** Tests used deterministic fake workers (`tests/fakes/fake-mcp-worker.ts`) to isolate manager routing and supervisor overhead from worker tool payload execution time.
3. **Autostart & Reboot Recovery:** Verified windowless autostart watchdog execution via `run-headless.vbs` under Windows Task Scheduler.
