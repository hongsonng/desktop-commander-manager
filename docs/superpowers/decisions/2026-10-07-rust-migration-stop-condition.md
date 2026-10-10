# Architecture Decision Record: Rust Migration Stop-Condition Review (M6)

**Decision Date:** 2026-10-10  
**Status:** APPROVED  
**Decision:** `CONTINUE_M7`  
**Milestone:** M6 (Stop-Condition Review)  
**Target Specification:** `docs/superpowers/specs/2026-10-07-rust-manager-migration-design.md`  
**Associated Benchmark Report:** `docs/benchmarks/2026-10-07-m6-stop-review.md`  

---

## 1. Context

Milestones M1 through M5 migrated the core control plane to Rust:
- Platform inspection and process-tree operations (M1)
- Authoritative worker supervision and crash recovery (M2-M3)
- SQLite state persistence and sticky-session routing (M4)
- Management HTTP API and dashboard static asset hosting (M5)

In this hybrid topology, public MCP HTTP ingress (`POST /mcp` with Streamable HTTP SSE) remains on Node.js Fastify, forwarding RPC requests to the authoritative Rust backend over a private stdio JSON-RPC sidecar protocol.

Milestone M6 requires evaluating whether to freeze the hybrid architecture (`STOP_HYBRID`) or continue to Milestone M7 (standalone Rust MCP ingress and unified binary).

---

## 2. Decision: CONTINUE_M7

The engineering evaluation concludes with a formal decision of **`CONTINUE_M7`**.

This decision is driven not by language purity, but by substantial, measured operational and resource advantages:

### 1. Memory Disproportion (93% in Node Ingress Host)
Measured data from M6 proves that the Rust manager backend uses only **8.6 MB RSS** while owning the database, SQLite WAL, supervisor, management API, static asset server, and session router. Conversely, the Node.js ingress host consumes **115.3 MB RSS** merely to parse HTTP requests and forward them via stdio.
Implementing M7 will reduce overall control-plane memory from ~124 MB down to ~15 MB, unlocking an ~88% overall memory reduction.

### 2. Elimination of Hybrid Dual-Process IPC
The hybrid model requires managing two processes (Node and Rust) with standard I/O pipes. Under high-throughput bursts, inter-process serialization and pipe buffering introduce 2–3 ms of latency and potential backpressure. Implementing native Axum MCP ingress terminates client HTTP traffic directly in the Tokio runtime alongside the router.

### 3. Unified Cross-Platform Deployment & Zero Node Host Dependency
A standalone Rust manager (`dcm-manager run`) packages all management, MCP, routing, and supervision capabilities into a single binary. This satisfies the user requirements for:
- Seamless migration and deployment to Linux/Ubuntu.
- Running without a Node.js development runtime installed on the host machine.
- Simplified system autostart (Windows Task Scheduler / Service or Linux systemd) without wrapper scripts (`run-headless.vbs`).

Workers remain pinned Node.js packages (`@wonderwhy-er/desktop-commander`), but the manager host itself becomes completely independent.

---

## 3. Consequences & Next Steps

1. **Branching:** Create `feature/rust-mcp-ingress` from `dev` according to `docs/superpowers/plans/2026-10-07-m7-mcp-ingress-standalone.md`.
2. **Contract Preservation:** The Rust MCP server must strictly maintain 100% parity with the frozen M0 MCP contract suite (`tests/contracts/mcp.contract.test.ts`), Streamable HTTP SSE semantics, and existing port mappings (`8787`).
3. **Rollback Safety:** Rollback to the Node.js Fastify MCP host remains preserved through environment configuration until M7 is fully verified and promoted.
