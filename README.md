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
- Exposes a **direct-local ChatGPT path**: ChatGPT → OpenAI Secure MCP Tunnel → this manager → local Desktop Commander workers.
- Keeps one stable MCP endpoint while worker routing, restart, and failover happen behind the manager.
- Manages multiple isolated Desktop Commander **Remote Device account profiles** as an optional hosted-RDC feature.

For the recommended direct-local ChatGPT path, a hosted Desktop Commander account is **not required**. Hosted Remote Device profiles are separate: the official hosted relay scopes both the AI connector and paired device to the same Desktop Commander account, so rotating a local hosted profile cannot silently change the OAuth identity already held by ChatGPT.

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Network access for the first `npx -y @wonderwhy-er/desktop-commander@latest` startup and Remote Device pairing

## Cách chạy nhanh

### Khuyến nghị: cài tự khởi động một lần

Double-click:

```text
install-autostart.bat
```

Script sẽ tự `npm install`, build dashboard, đăng ký autostart và khởi động manager ngay. Installer ưu tiên Windows Task Scheduler; nếu tài khoản Windows hiện tại không có quyền tạo task, nó tự fallback sang `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` nên không cần chạy Administrator. Từ những lần đăng nhập Windows sau, manager chạy headless tự động. Secure MCP Tunnel chỉ được đăng ký khi `tunnel-client` **và** profile `desktop-commander-manager` đã được cấu hình.

Để gỡ autostart:

```text
uninstall-autostart.bat
```

### Cấu hình Secure MCP Tunnel một lần

Sau khi tạo tunnel trong OpenAI Platform và tạo **Runtime API key** dạng Restricted có quyền **Tunnels Read + Use**, double-click:

```text
setup-tunnel.bat
```

Script sẽ nhận `tunnel_id` và API key bằng secure prompt, lưu key ngoài repo tại `%APPDATA%\tunnel-client\secrets\desktop-commander-manager.api-key`, tạo profile `%APPDATA%\tunnel-client\desktop-commander-manager.yaml` trỏ tới `http://127.0.0.1:8787/mcp`, chạy `doctor`, rồi chỉ bật tunnel autostart khi kiểm tra thành công.

Không dán runtime API key vào source code, `.env`, Git hoặc chat.

### Chạy tay / debug

Double-click:

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

### Autostart hoạt động như thế nào

- Installer thử tạo Task Scheduler entry `DesktopCommanderManager` trước.
- Nếu Windows trả `Access is denied`, installer tự ghi entry cùng tên vào `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`; cơ chế này chạy theo user hiện tại và không cần Administrator.
- Cả hai cơ chế đều chạy `scripts/run-manager-headless.ps1` khi user đăng nhập Windows.
- Runner kiểm tra health trước để không tạo instance trùng.
- Nếu manager crash, runner tự thử khởi động lại tối đa 10 lần, mỗi lần cách 5 giây.
- Log manager: `data/logs/manager-autostart.log`.
- Nếu có `tunnel-client`, `DesktopCommanderTunnel` chạy `scripts/run-tunnel-headless.ps1` bằng Task Scheduler hoặc HKCU Run tương tự.
- Tunnel runner chờ manager healthy, kiểm tra profile `desktop-commander-manager`, rồi tự reconnect nếu tunnel process dừng.
- Log tunnel: `data/logs/tunnel-autostart.log`.
- Không có API key/secret nào được ghi vào repo; tunnel dùng credential/environment mà `tunnel-client` đã được cấu hình bên ngoài repo.

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

## Optional: hosted Remote Desktop Commander profiles

This section is **not required** for the recommended direct-local ChatGPT connection. Use it only when you also want to run Desktop Commander's hosted Remote MCP device profiles.

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
- `GET /api/connection`
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

Recommended flow:

```text
ChatGPT
  → OpenAI Secure MCP Tunnel
  → http://127.0.0.1:8787/mcp
  → Desktop Commander Manager
  → local Desktop Commander worker
```

Configure the ChatGPT developer-mode connector/tunnel **once**. After that, keep the same ChatGPT connector and MCP endpoint; worker restarts and failover happen behind the manager without changing ChatGPT OAuth accounts.

Use OpenAI Secure MCP Tunnel rather than exposing port 8787 to the public internet. See [`docs/secure-mcp-tunnel.md`](docs/secure-mcp-tunnel.md).

For local protocol debugging, point MCP Inspector at `http://127.0.0.1:8787/mcp` while the manager is running.

## Current MVP limits

- One Windows machine.
- The direct-local path still needs a one-time ChatGPT Secure MCP Tunnel/connector setup.
- Hosted Remote Device account rotation is separate and cannot replace the OAuth identity already authorized by a hosted RDC connector.
- No Tauri/system-tray packaging yet.
- No OS security sandbox between workers/profiles; isolation is process/runtime-state separation.
