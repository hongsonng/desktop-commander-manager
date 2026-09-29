# Desktop Commander Manager

Windows-first MCP router for running multiple isolated **local** Desktop Commander workers behind one MCP endpoint.

## What it does

- Exposes one Streamable HTTP MCP endpoint at `http://127.0.0.1:8787/mcp`.
- Uses ChatGPT `_meta["openai/session"]` as an opaque sticky routing key.
- Starts two Desktop Commander stdio workers by default and gives each its own `USERPROFILE`, `HOME`, `TEMP`, and `TMP` runtime directories.
- Persists session-to-worker bindings in SQLite.
- Restarts an unhealthy worker, performs a fresh MCP handshake, and keeps the binding when recovery succeeds.
- Rebinds a conversation only when recovery fails and another healthy worker exists.
- Never blindly replays a tool call when upstream acknowledgement is ambiguous.
- Serves a local operations dashboard and management API on `http://127.0.0.1:8788`.

This MVP does **not** aggregate hosted Remote MCP quotas and does not store Desktop Commander hosted-account credentials.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Network access for the first `npx -y @wonderwhy-er/desktop-commander@latest` worker startup

## Install and run

```powershell
cd D:\SonCFS\desktop-commander-manager
npm install
npm run build
npm run dev
```

The manager prints the MCP and dashboard URLs when startup completes. The dashboard is available at `http://127.0.0.1:8788/` after `npm run build`.

> When running npm through an environment that omits Windows `ComSpec`, set `$env:ComSpec="$env:SystemRoot\System32\cmd.exe"` for that terminal session before `npm install`.

## Runtime layout

```text
data/
  manager.db
  workers/
    worker-1/
      home/
      temp/
      logs/
    worker-2/
      home/
      temp/
      logs/
```

Runtime DBs, worker homes, logs, build output, worktrees, and Superpowers scratch state are ignored by Git.

## Routing behavior

1. A new session is assigned to the healthy worker with the fewest active sessions.
2. Failure count breaks a load tie; deterministic round-robin breaks a complete tie.
3. The binding is persisted and reused for later calls from the same session.
4. If the bound worker fails, the manager restarts its process and reconnects a new MCP client.
5. If handshake recovery succeeds, the session stays on the same worker.
6. If recovery fails, the binding moves transactionally to another healthy worker.

For requests where it is unknown whether the upstream worker already began execution, the manager returns an MCP error instead of replaying the request and risking a duplicate filesystem/process mutation.

## Operations

Management API:

- `GET /api/health`
- `GET /api/workers`
- `GET /api/sessions`
- `GET /api/events`
- `POST /api/workers/:id/restart`
- `POST /api/workers/:id/enable`
- `POST /api/workers/:id/disable`

The management server is hard-bound to `127.0.0.1` in the MVP.

## Development and verification

```powershell
npm test
npm run test:integration
npm run build
npm run smoke:windows
```

The Windows smoke test starts two **real local Desktop Commander** workers, waits for manager health, discovers tools through the router, calls only the read-only `get_config` tool, verifies the sticky session binding, then shuts everything down in `finally`.

## Connect ChatGPT privately

Use OpenAI Secure MCP Tunnel rather than exposing port 8787 to the public internet. See [`docs/secure-mcp-tunnel.md`](docs/secure-mcp-tunnel.md).

For local protocol debugging, point MCP Inspector at `http://127.0.0.1:8787/mcp` while `npm run dev` is running.

## Current MVP limits

- One Windows machine.
- Local Desktop Commander workers only; no hosted-account quota pooling.
- No Tauri/system-tray packaging yet.
- No OS security sandbox between workers; isolation is process/runtime-state separation.
