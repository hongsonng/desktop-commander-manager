# Secure MCP Tunnel runbook

The manager listens only on `127.0.0.1:8787/mcp`. Use OpenAI Secure MCP Tunnel when ChatGPT must reach this private endpoint without exposing an inbound public port.

Official guide: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Prerequisites

- Build and start Desktop Commander Manager: `npm run build`, then `npm run dev`.
- Confirm `http://127.0.0.1:8788/api/health` returns `status: ok`.
- Create a tunnel in OpenAI Platform tunnel settings and associate it with the target ChatGPT workspace / Platform organization.
- Install the latest public `tunnel-client` release from the Platform tunnel settings or OpenAI's latest release link.
- Keep the runtime API key outside the repository. Never put it in `.env`, source code, docs, or Git history.

## Configure the tunnel

This is a one-time setup. After the `desktop-commander-manager` tunnel profile works once, `install-autostart.bat` can register `DesktopCommanderTunnel` so the profile starts automatically at Windows logon together with the manager.

Start with the current CLI help because tunnel-client flags may evolve:

```powershell
tunnel-client help quickstart
```

Use the tunnel ID shown in Platform settings and configure the private MCP target as:

```text
http://127.0.0.1:8787/mcp
```

For HTTP MCP, use the current `--mcp-server-url` option shown by the official quickstart. Set `CONTROL_PLANE_API_KEY` only in the process/session that runs tunnel-client.

Validate before connecting ChatGPT:

```powershell
tunnel-client doctor --profile desktop-commander-manager --explain
tunnel-client run --profile desktop-commander-manager
```

After that first successful validation, stop the foreground tunnel and run `install-autostart.bat` again. If `tunnel-client` is discoverable in `PATH`, the installer registers and starts the tunnel task automatically. The headless tunnel runner waits for manager health and reconnects the tunnel if it exits.

The tunnel is outbound-only: the local machine needs HTTPS access to OpenAI and local access to `127.0.0.1:8787`; the MCP router does not need an inbound internet-facing listener.

## Connect from ChatGPT

In ChatGPT Plugins, create a developer-mode app, choose **Tunnel** as the connection, and select the tunnel associated with the workspace. If the tunnel is missing, check both ChatGPT developer-mode permission and Platform Tunnels Read + Use permission.

## Troubleshooting

- Router health: `http://127.0.0.1:8788/api/health`
- Tunnel diagnostics: `tunnel-client doctor --profile desktop-commander-manager --explain`
- Tunnel local admin UI: use the loopback `/ui` endpoint shown by tunnel-client.
- Do not make ports 8787/8788 public as a workaround; fix tunnel association, permission, or local reachability instead.
