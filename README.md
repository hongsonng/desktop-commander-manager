# Desktop Commander Manager

Windows-first MCP router and Remote Desktop Commander profile manager.

## What it does

- Exposes one Streamable HTTP MCP endpoint at `http://127.0.0.1:8787/mcp`.
- Uses ChatGPT `_meta["openai/session"]` as an opaque sticky routing key.
- Starts two Desktop Commander stdio workers by default and gives each its own `USERPROFILE`, `HOME`, `TEMP`, and `TMP` runtime directories.
- Persists session-to-worker bindings in SQLite.
- Restarts an unhealthy worker, performs a fresh MCP handshake, and keeps the binding when recovery succeeds.
- Rebinds a conversation only when recovery fails and another healthy worker exists.
- Never blindly replays a tool call when upstream acknowledgement is ambiguous.
- Serves a local operations dashboard and management API on `http://127.0.0.1:8788`.
- Manages multiple isolated Desktop Commander **Remote Device account profiles** and can activate or rotate them one at a time.

The Remote account manager does **not** pool hosted Remote MCP quotas behind one ChatGPT OAuth connection. Each Remote Device profile still belongs to the Desktop Commander account used during its own OAuth pairing flow.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Network access for the first `npx -y @wonderwhy-er/desktop-commander@latest` startup and Remote Device pairing

## Cách chạy nhanh

Cách đơn giản nhất trên Windows là double-click file:

```text
start-manager.bat
```

File BAT tự chuyển CMD sang UTF-8, kiểm tra Node/npm, tự cài dependencies nếu cần, build dashboard lần đầu và chạy manager với thông báo tiếng Việt có màu.

Nếu muốn chạy thủ công bằng PowerShell:

```powershell
cd D:\SonCFS\desktop-commander-manager
$env:ComSpec="$env:SystemRoot\System32\cmd.exe"
npm install
npm run build
npm run dev
```

Sau khi start:

- Dashboard: `http://127.0.0.1:8788/`
- MCP endpoint: `http://127.0.0.1:8787/mcp`

Những lần chạy sau, nếu dependencies không thay đổi, chỉ cần:

```powershell
cd D:\SonCFS\desktop-commander-manager
$env:ComSpec="$env:SystemRoot\System32\cmd.exe"
npm run dev
```

Biến `ComSpec` được đặt rõ ràng vì một số terminal/automation environment trên Windows có thể không truyền biến này cho npm lifecycle scripts.

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
  remote-accounts/
    account-a/
      home/
        .desktop-commander-device/
          device.json
      temp/
      logs/
    account-b/
      home/
      temp/
      logs/
```

`device.json` is created and maintained by Desktop Commander itself during Remote Device OAuth pairing. The manager only checks whether that profile-local file exists; it does not read, copy, expose, or persist the credential in SQLite.

Runtime DBs, worker homes, Remote account profiles, logs, build output, worktrees, and Superpowers scratch state are ignored by Git.

## Remote account rotation

1. Start the manager and open `http://127.0.0.1:8788/`.
2. Under **Remote accounts**, add an account id and display name.
3. Click **Activate**. The manager launches `desktop-commander remote` with a HOME dedicated to that account.
4. If the profile is not paired yet, complete Desktop Commander's normal browser/device OAuth flow with the intended account.
5. The dashboard refreshes the `Paired` state from the profile-local RDC credential file.
6. Add additional accounts the same way.
7. Use **Rotate next** to stop the currently active Remote Device process and start the next enabled profile in round-robin order.
8. Disable a profile to remove it from rotation without deleting its RDC credential/profile data.

Only one managed Remote Device account process is active at a time. Unexpected process exits are recorded as `ERROR` and appear in the event log.

### Important OAuth limitation

Switching the Remote Device process on this Windows machine does not silently switch the ChatGPT-side Desktop Commander connector to another hosted account. The ChatGPT connector and the Remote Device pairing both have their own account authorization. This feature is therefore a profile/process switcher and rotation manager, not a transparent multi-account quota combiner.

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
- `GET /api/remote-accounts`
- `POST /api/remote-accounts` with `{ "id": "account-a", "name": "Account A" }`
- `POST /api/remote-accounts/:id/activate`
- `POST /api/remote-accounts/:id/stop`
- `POST /api/remote-accounts/:id/enable`
- `POST /api/remote-accounts/:id/disable`
- `POST /api/remote-accounts/rotate`

The management server is hard-bound to `127.0.0.1` in the MVP.

## Development and verification

```powershell
npm test
npm run test:integration
npm run build
npm run smoke:windows
```

The Windows smoke test starts two **real local Desktop Commander** workers, waits for manager health, discovers tools through the router, calls only the read-only `get_config` tool, verifies the sticky session binding, then shuts everything down in `finally`.

Remote account unit/integration tests use fake process factories so automated verification never launches a browser or logs into a real account.

## Connect ChatGPT privately

Use OpenAI Secure MCP Tunnel rather than exposing port 8787 to the public internet. See [`docs/secure-mcp-tunnel.md`](docs/secure-mcp-tunnel.md).

For local protocol debugging, point MCP Inspector at `http://127.0.0.1:8787/mcp` while `npm run dev` is running.

## Current MVP limits

- One Windows machine.
- Remote Device profile switching only; no transparent hosted-account quota pooling.
- No automatic quota detection because the Remote Device CLI does not expose a stable quota API here.
- No Tauri/system-tray packaging yet.
- No OS security sandbox between workers/profiles; isolation is process/runtime-state separation.
