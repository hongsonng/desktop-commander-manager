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

This is a one-time setup. Create or inspect the tunnel in Platform tunnel settings, then create a **Restricted Runtime API key** with **Tunnels Read + Use**.

On this repository, run:

```text
setup-tunnel.bat
```

The setup script asks for the `tunnel_id` and runtime key using a hidden prompt. It stores the key outside the repository under `%APPDATA%\tunnel-client\secrets`, restricts that file to the current Windows user, creates profile `desktop-commander-manager` with MCP target `http://127.0.0.1:8787/mcp`, and keeps only a `file:` secret reference in YAML.

The script then runs:

```powershell
tunnel-client doctor --profile desktop-commander-manager --explain
```

Only after `doctor` succeeds does it rerun the autostart installer. `DesktopCommanderTunnel` is registered as a minute-based Task Scheduler watchdog: it starts the headless runner after login and starts it again if the runner is no longer running. Task Scheduler ignores a new instance while the existing runner is active. If Task Scheduler is denied, the installer falls back to the per-user HKCU Run key, which provides logon startup but not the same watchdog guarantee. The headless tunnel runner waits for manager health and reconnects the tunnel if it exits.

For CLI discovery or manual troubleshooting, use:

```powershell
tunnel-client help quickstart
tunnel-client run --profile desktop-commander-manager
```

The tunnel is outbound-only: the local machine needs HTTPS access to OpenAI and local access to `127.0.0.1:8787`; the MCP router does not need an inbound internet-facing listener.

## Connect from ChatGPT

In ChatGPT Plugins, create a developer-mode app, choose **Tunnel** as the connection, and select the tunnel associated with the workspace. If the tunnel is missing, check both ChatGPT developer-mode permission and Platform Tunnels Read + Use permission.

## Troubleshooting

- Router health: `http://127.0.0.1:8788/api/health`
- Tunnel diagnostics: `tunnel-client doctor --profile desktop-commander-manager --explain`
- Tunnel local admin UI: use the loopback `/ui` endpoint shown by tunnel-client.
- Do not make ports 8787/8788 public as a workaround; fix tunnel association, permission, or local reachability instead.
