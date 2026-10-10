# Benchmark Methodology and Baseline Reference

This document outlines the benchmarking harness and reproducibility standards for measuring Desktop Commander Manager performance across Node.js and Rust implementations.

## Methodology

### 1. Isolation Strategy
- All benchmark instances run in isolated ephemeral temporary directories created in the system temp directory (`dc-bench-host-*`).
- Ephemeral ports (`port: 0`) are used for both MCP HTTP ingress and management API endpoints to prevent collisions with production ports `8787` and `8788`.
- Ephemeral databases (`manager.db`) are created and torn down per test run.
- Synthetic fast MCP workers are used (`tests/fakes/fake-mcp-worker.ts`) to ensure that upstream worker execution duration does not dominate the measurement of manager routing overhead.

### 2. Sample Counts
- **Full Baseline:**
  - Cold starts: 50 runs
  - `tools/list`: 500 calls
  - `tools/call`: 1,000 calls
  - Worker restart cycles: 100 runs
  - Crash recovery cycles: 20 runs
- **Quick Smoke (`--quick`):**
  - Cold starts: 5 runs
  - `tools/list`: 50 calls
  - `tools/call`: 50 calls
  - Worker restart cycles: 5 runs
  - Crash recovery cycles: 3 runs

### 3. Metrics and Statistics
- Nearest-rank percentile calculation (`tests/benchmarks/metrics.ts`).
- Recorded metrics: `count`, `min`, `median`, `p95`, `p99`, `max`, `mean`.
- Raw samples are preserved in `benchmarks/results/node-baseline.json` (ignored from Git) for full distribution analysis.

### 4. Readiness Definitions
- **Manager-ready:** Health endpoint `GET /api/health` returns HTTP 200 `status: "ok"`.
- **Workers-ready:** All configured workers report `READY` status in database and have completed initial MCP handshake.

## How to Reproduce

Run quick smoke test:
```bash
npm run benchmark:node -- --quick
```

Run full baseline measurement:
```bash
npm run benchmark:node
```
