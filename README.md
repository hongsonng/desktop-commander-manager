# Desktop Commander Manager

Windows-first MCP router for local Desktop Commander workers.

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

## Requirements

- Windows 10/11
- Node.js 22+
- npm
- Network access for the first `npx -y @wonderwhy-er/desktop-commander@latest` startup

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
- `GET /api/connection`
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
- No Tauri/system-tray packaging yet.
- No OS security sandbox between workers; isolation is process/runtime-state separation.
