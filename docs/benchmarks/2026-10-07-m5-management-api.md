# M5 Management API Benchmark Report

**Date:** 2026-10-10T06:58:50.049Z
**Platform:** undefined (undefined)
**CPUs:** undefined
**Samples per endpoint:** 100

## Summary Table (Latency in ms)

| Endpoint | Node p50 | Node p95 | Node Mean | Rust p50 | Rust p95 | Rust Mean |
|---|---|---|---|---|---|---|
| `GET /api/health` | 0.49 | 0.94 | 0.57 | 0.27 | 0.39 | 0.31 |
| `GET /api/workers` | 0.69 | 1.03 | 0.75 | 0.28 | 0.41 | 0.33 |
| `GET /api/resources` | 9.01 | 10.86 | 9.21 | 7.42 | 7.95 | 7.49 |
| `GET /api/events` | 0.64 | 1.02 | 0.76 | 0.29 | 0.39 | 0.31 |
| Worker Mutations | 58.18 | 63.67 | 59.53 | 61.14 | 76.72 | 58.98 |

## Control Plane Memory

- **Node Management API Owner Combined RSS:** 253.1 MB
- **Rust Management API Owner Combined RSS:** 105.8 MB

## Promotion Gate Decision

- Correctness parity: **PASS** (100% contract match verified by `tests/contracts/management-api-owner.contract.test.ts`)
- Rollback capability: **PASS** (Bidirectional `DCM_MANAGEMENT_API_OWNER=node` supported and tested)
- Static Dashboard Serving: **PASS** (Secure static directory serving via tower-http with path traversal rejection)
- Decision: **APPROVED for promotion to dev**
